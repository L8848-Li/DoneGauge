import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { loadConfig } from '../dist/src/core/config.js';
import { runCommand } from '../dist/src/core/runner.js';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [tarballPath, ...extraArgs] = process.argv.slice(2);
assert.equal(extraArgs.length, 0, 'Usage: npm run test:dsh-host -- [tarball]');
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), 'donegauge-dsh-host-')),
);
const project = join(temporary, 'project');
await cp(join(source, 'examples/node-registration'), project, {
  recursive: true,
});
const init = await runCommand(['git', 'init', '-q'], project);
assert.equal(init.exitCode, 0, init.stderr);
const configPath = 'donegauge.junit.json';
const approval = (await loadConfig(project, configPath)).sha256;
const resultPath = join(temporary, 'host-result.json');
const smokePath = join(temporary, 'smoke.mjs');
await writeFile(
  smokePath,
  `
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
export const name = 'donegauge-host-smoke';
export const inject = ['tools'];
export function apply(ctx) {
  const work = async () => {
    for (let i=0;i<100;i++) {
      await delay(50);
      if (!ctx.tools.get('donegauge_check')) continue;
      try {
        const outcome = await ctx.tools.execute({
          calls: [{ type: 'tool-call', id: 'donegauge-host-smoke', name: 'donegauge_check', arguments: '{}' }],
          signal: new AbortController().signal,
        });
        await writeFile(${JSON.stringify(resultPath)}, JSON.stringify(outcome));
        return;
      } catch(error) {
        if (error.name === 'ToolExecutorUnavailableError') continue;
        throw error;
      }
    }
    throw new Error('Host tool registration did not become available.');
  };
  void work().catch(error => writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ error: error.message })));
}
`,
);
const patch = join(temporary, 'host.patch.yml');
await writeFile(
  patch,
  `- insert:
    - id: donegauge-host-native
      name: '@deepseek-ai/dsh-tool-executor-native'
    - id: donegauge-host-smoke
      name: ${JSON.stringify(smokePath)}
- id: donegauge
  config:
    root: ${JSON.stringify(project)}
    configPath: ${JSON.stringify(configPath)}
    approvedConfigSha256: ${JSON.stringify(approval)}
`,
);

// Use an explicit CLI, or the official macOS Desktop bundled CLI if present.
const desktop = '/Applications/DeepSeek Harness.app/Contents';
const executable =
  process.env.DONEGAUGE_DSH_EXECUTABLE ??
  (process.platform === 'darwin'
    ? join(desktop, 'MacOS/DeepSeek Harness')
    : 'dsh');
const cliEntry =
  process.env.DONEGAUGE_DSH_CLI_ENTRY ??
  (process.platform === 'darwin'
    ? join(
        desktop,
        'Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
      )
    : '');
const prefix = cliEntry ? [cliEntry] : [];
const env = {
  ...process.env,
  DSH_HOME: join(temporary, 'home'),
  DSH_TELEMETRY_DISABLED: '1',
  ...(cliEntry ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
};
await mkdir(env.DSH_HOME, { recursive: true });
const version = await runCommand(
  [executable, ...prefix, '--version'],
  project,
  { env },
);
assert.equal(version.exitCode, 0, version.stderr);

let tarball;
if (tarballPath) {
  tarball = await realpath(tarballPath);
} else {
  const packed = await runCommand(
    [
      'npm',
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      temporary,
    ],
    source,
  );
  assert.equal(packed.exitCode, 0, packed.stderr + packed.stdout);
  tarball = join(temporary, JSON.parse(packed.stdout)[0].filename);
}
const installed = await runCommand(
  [
    executable,
    ...prefix,
    'plugin',
    '--profile',
    'donegauge-smoke',
    'add',
    tarball,
    '--ignore-scripts',
  ],
  project,
  { env, timeoutMs: 30_000 },
);
assert.equal(installed.exitCode, 0, installed.stderr + installed.stdout);
const dump = await runCommand(
  [
    executable,
    ...prefix,
    '--profile',
    'donegauge-smoke',
    '--patch',
    patch,
    '--dump-config',
  ],
  project,
  { env },
);
assert.equal(dump.exitCode, 0, dump.stderr + dump.stdout);
assert.match(dump.stdout, /name: +['"]?donegauge['"]?\s/);
const host = spawn(
  executable,
  [...prefix, '--profile', 'donegauge-smoke', '--patch', patch],
  { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
host.stdout.on('data', (data) => {
  log = (log + data.toString()).slice(-20_000);
});
host.stderr.on('data', (data) => {
  log = (log + data.toString()).slice(-20_000);
});
let spawnError;
host.on('error', (error) => {
  spawnError = error;
});
const ended = new Promise((resolve) => host.on('close', resolve));
try {
  let outcome;
  for (let i = 0; i < 300; i++) {
    if (spawnError) throw spawnError;
    const text = await readFile(resultPath, 'utf8').catch(() => null);
    if (text) {
      outcome = JSON.parse(text);
      break;
    }
    if (host.exitCode !== null)
      throw new Error(`DSH exited before producing evidence.\n${log}`);
    await delay(50);
  }
  assert.ok(outcome, `DSH did not produce a tool result.\n${log}`);
  const result = outcome.results?.[0]?.result;
  assert.equal(result?.isError, false, JSON.stringify(outcome) + '\n' + log);
  assert.equal(result.value.summary.PASS, 3);
  assert.equal(result.value.finalStatus, 'VERIFIED');
  const report = JSON.parse(
    await readFile(join(project, result.value.reports.json), 'utf8'),
  );
  for (const [index, criterion] of report.criteria.entries()) {
    assert.equal(criterion.evidence?.state, 'exited');
    assert.equal(criterion.evidence.exitCode, 0);
    assert.equal(criterion.testEvidence.counts.executedTargets, 1);
    assert.equal(criterion.testEvidence.executionId, criterion.evidence.id);
    const returned = result.value.criteria[index];
    assert.equal(returned.executedTargetTests, 1);
    assert.equal(returned.evidenceId, criterion.evidence.id);
    assert.equal(returned.testEvidencePath, criterion.testEvidence.source.path);
    assert.ok(
      (await readFile(join(project, returned.testEvidencePath))).length,
    );
  }
  console.log(
    `DSH ${version.stdout.trim()}: installed ${tarball}, dispatched donegauge_check, and verified 3 named tests with saved JUnit evidence.`,
  );
  console.log(`Isolated host evidence: ${resultPath}`);
} finally {
  host.kill('SIGTERM');
  const force = setTimeout(() => host.kill('SIGKILL'), 2000);
  await ended;
  clearTimeout(force);
}
