import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [tarballPath, ...extraArgs] = process.argv.slice(2);
assert.equal(
  extraArgs.length,
  0,
  'Usage: npm run test:package -- [tarball|--registry]',
);
const { name, version, license, repository } = JSON.parse(
  await readFile(join(source, 'package.json'), 'utf8'),
);
const registry = tarballPath === '--registry';
const windows = process.platform === 'win32';
const npmEntry =
  process.env.npm_execpath ??
  (windows
    ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    : undefined);
const npm = (args, cwd) =>
  npmEntry
    ? execute(process.execPath, [npmEntry, ...args], { cwd })
    : execute('npm', args, { cwd });
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), 'donegauge-package-')),
);
const consumer = join(temporary, 'consumer');
await mkdir(consumer);
try {
  let tarball;
  if (registry) {
    tarball = null;
  } else if (tarballPath) {
    tarball = await realpath(tarballPath);
  } else {
    await npm(['run', 'build'], source);
    const packed = await npm(
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      source,
    );
    tarball = join(temporary, JSON.parse(packed.stdout)[0].filename);
  }
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'donegauge-install-smoke',
      version: '1.0.0',
      private: true,
    }),
  );
  await npm(
    [
      'install',
      '--prefer-offline',
      '--omit=dev',
      '--omit=optional',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...(registry ? ['--registry=https://registry.npmjs.org'] : []),
      tarball ?? `${name}@${version}`,
    ],
    consumer,
  );
  assert.ok(
    !(await readdir(join(consumer, 'node_modules'))).includes('@deepseek-ai'),
    'Standalone CLI must not require DSH packages.',
  );
  const installed = join(consumer, 'node_modules', name);
  const manifest = JSON.parse(
    await readFile(join(installed, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  assert.equal(manifest.license, license);
  assert.equal(manifest.repository.url, repository.url);
  const files = (await readdir(installed, { recursive: true })).map((path) =>
    path.split(sep).join('/'),
  );
  for (const file of [
    'cordis.patch.yml',
    'schema/donegauge.schema.json',
    'dist/src/cli.js',
    'dist/src/adapters/dsh/index.js',
    'dist/src/adapters/dsh/client.js',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    assert.ok(files.includes(file), `Missing installed file: ${file}`);
  }
  assert.ok(!files.includes('dist/tests'));
  assert.ok(
    !files.some((file) =>
      file
        .split('/')
        .some((part) =>
          /^(?:\.donegauge|\.env(?:\..*)?|\.npmrc|\.git|node_modules|__pycache__)$/.test(
            part,
          ),
        ),
    ),
  );
  const bin = join(
    consumer,
    'node_modules',
    '.bin',
    windows ? 'donegauge.cmd' : 'donegauge',
  );
  const { runCommand } = await import(
    pathToFileURL(join(installed, 'dist/src/core/runner.js')).href
  );
  const installedCli = async (args, cwd = consumer) => {
    const result = await runCommand([bin, ...args], cwd, {
      maxOutputBytes: 10 * 1024 * 1024,
    });
    assert.equal(result.state, 'exited', JSON.stringify(result));
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  assert.equal((await installedCli(['--version'])).trim(), version);
  await cp(join(source, 'examples/node-registration'), consumer, {
    recursive: true,
  });
  await writeFile(join(consumer, '.gitignore'), 'node_modules/\n.donegauge/\n');
  await execute('git', ['init', '-q'], { cwd: consumer });
  const report = JSON.parse(
    await installedCli(['check', '--allow-run', '--json']),
  );
  assert.equal(report.toolVersion, version);
  assert.equal(report.finalStatus, 'VERIFIED');
  assert.equal(report.summary.PASS, 3);
  assert.ok(
    report.criteria.every((criterion) => criterion.evidence?.exitCode === 0),
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(consumer, `.donegauge/runs/${report.runId}/report.json`),
        'utf8',
      ),
    ).runId,
    report.runId,
  );
  assert.ok(
    (await stat(join(consumer, `.donegauge/runs/${report.runId}/report.md`)))
      .size > 0,
  );
  const junitReport = JSON.parse(
    await installedCli([
      'check',
      '--config',
      'donegauge.junit.json',
      '--allow-run',
      '--json',
    ]),
  );
  assert.equal(junitReport.finalStatus, 'VERIFIED');
  assert.equal(junitReport.summary.PASS, 3);
  for (const criterion of junitReport.criteria) {
    assert.equal(criterion.testEvidence.counts.executedTargets, 1);
    assert.equal(criterion.testEvidence.executionId, criterion.evidence.id);
    assert.ok(
      (await readFile(join(consumer, criterion.testEvidence.source.path)))
        .length > 0,
    );
  }
  const pythonProject = join(temporary, 'python smoke 中文');
  await cp(join(source, 'examples/python-cart'), pythonProject, {
    recursive: true,
  });
  const configFile = join(pythonProject, 'donegauge.json');
  const pythonConfig = JSON.parse(await readFile(configFile, 'utf8'));
  for (const criterion of pythonConfig.criteria)
    criterion.check.command[0] =
      process.env.DONEGAUGE_PYTHON ?? (windows ? 'python' : 'python3');
  await writeFile(configFile, JSON.stringify(pythonConfig));
  await execute('git', ['init', '-q'], { cwd: pythonProject });
  const python = JSON.parse(
    await installedCli(['check', '--allow-run', '--json'], pythonProject),
  );
  assert.equal(python.summary.PASS, 2);
  assert.equal(python.finalStatus, 'VERIFIED');
  console.log(
    `Package install smoke passed: ${tarball ? `${tarball} (${(await stat(tarball)).size} bytes)` : `${name}@${version} from npm`}, 3 Node command + 3 Node JUnit + 2 Python checks.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
