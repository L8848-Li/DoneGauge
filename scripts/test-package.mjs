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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [tarballPath, ...extraArgs] = process.argv.slice(2);
assert.equal(extraArgs.length, 0, 'Usage: npm run test:package -- [tarball]');
const { version } = JSON.parse(
  await readFile(join(source, 'package.json'), 'utf8'),
);
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), 'donegauge-package-')),
);
const consumer = join(temporary, 'consumer');
await mkdir(consumer);
try {
  let tarball;
  if (tarballPath) {
    tarball = await realpath(tarballPath);
  } else {
    await execute('npm', ['run', 'build'], { cwd: source });
    const packed = await execute(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
      { cwd: source },
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
  await execute(
    'npm',
    [
      'install',
      '--prefer-offline',
      '--omit=dev',
      '--omit=optional',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    { cwd: consumer },
  );
  assert.ok(
    !(await readdir(join(consumer, 'node_modules'))).includes('@deepseek-ai'),
    'Standalone CLI must not require DSH packages.',
  );
  const installed = join(consumer, 'node_modules', 'donegauge');
  const files = await readdir(installed, { recursive: true });
  for (const file of [
    'cordis.patch.yml',
    'schema/donegauge.schema.json',
    'dist/src/cli.js',
    'dist/src/adapters/dsh/index.js',
  ]) {
    assert.ok(files.includes(file), `Missing installed file: ${file}`);
  }
  assert.ok(!files.includes('dist/tests'));
  assert.ok(!files.some((file) => file.split('/').includes('.donegauge')));
  const bin = join(consumer, 'node_modules', '.bin', 'donegauge');
  assert.equal(
    (await execute(bin, ['--version'], { cwd: consumer })).stdout.trim(),
    version,
  );
  await cp(join(source, 'examples/node-registration'), consumer, {
    recursive: true,
  });
  await writeFile(join(consumer, '.gitignore'), 'node_modules/\n.donegauge/\n');
  await execute('git', ['init', '-q'], { cwd: consumer });
  const checked = await execute(bin, ['check', '--allow-run', '--json'], {
    cwd: consumer,
    maxBuffer: 10 * 1024 * 1024,
  });
  const report = JSON.parse(checked.stdout);
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
  const junitChecked = await execute(
    bin,
    ['check', '--config', 'donegauge.junit.json', '--allow-run', '--json'],
    {
      cwd: consumer,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const junitReport = JSON.parse(junitChecked.stdout);
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
  console.log(
    `Package install smoke passed: installed ${tarball} (${(await stat(tarball)).size} bytes), executable ${version}, 3 command + 3 JUnit checks with local evidence.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
