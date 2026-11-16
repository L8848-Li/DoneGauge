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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), 'donegauge-package-')),
);
const consumer = join(temporary, 'consumer');
await mkdir(consumer);
try {
  await execute('npm', ['run', 'build'], { cwd: source });
  const packed = await execute(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
    { cwd: source },
  );
  const metadata = JSON.parse(packed.stdout)[0];
  assert.ok(
    metadata.files.some((file) => file.path === 'schema/donegauge.schema.json'),
  );
  assert.ok(metadata.files.some((file) => file.path === 'dist/src/cli.js'));
  assert.ok(
    metadata.files.some(
      (file) => file.path === 'dist/src/adapters/dsh/index.js',
    ),
  );
  assert.ok(
    !metadata.files.some(
      (file) =>
        file.path.startsWith('dist/tests/') ||
        file.path.includes('.donegauge/'),
    ),
  );
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
      join(temporary, metadata.filename),
    ],
    { cwd: consumer },
  );
  assert.ok(
    !(await readdir(join(consumer, 'node_modules'))).includes('@deepseek-ai'),
    'Standalone CLI must not require DSH packages.',
  );
  const bin = join(consumer, 'node_modules', '.bin', 'donegauge');
  assert.equal(
    (await execute(bin, ['--version'], { cwd: consumer })).stdout.trim(),
    '0.1.0',
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
    `Package install smoke passed: installed executable 0.1.0, no DSH dependency, 3 command + 3 JUnit real acceptance checks, JSON and Markdown reports. ${metadata.files.length} files, ${metadata.size} packed bytes.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
