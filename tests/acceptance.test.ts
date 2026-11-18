import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkAcceptance } from '../src/core/check.js';
import { loadConfig } from '../src/core/config.js';
import {
  renderJson,
  renderMarkdown,
  renderTerminal,
  writeReports,
} from '../src/reporters/index.js';
import type { AcceptanceReport } from '../src/core/types.js';
import {
  configWith,
  execGit,
  newRepo,
  reportFrom,
  runCli,
  saveConfig,
  tempDirectory,
} from './helpers.js';

const { version } = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

test('CLI runs real Node registration project: three passes and traceable evidence', async (t) => {
  const root = await newRepo(t, 'node-registration');
  await writeFile(join(root, 'tracked.txt'), 'working tree change\n');
  const result = await runCli(root, ['check', '--allow-run', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as AcceptanceReport;
  assert.equal(report.toolVersion, version);
  assert.deepEqual(report.summary, {
    PASS: 3,
    FAIL: 0,
    UNVERIFIED: 0,
    ERROR: 0,
  });
  assert.equal(report.finalStatus, 'VERIFIED');
  assert.equal(report.workspaceChangedDuringRun, false);
  assert.equal(report.changes.files[0]?.path, 'tracked.txt');
  for (const criterion of report.criteria) {
    assert.equal(criterion.evidence?.exitCode, 0);
    assert.ok(criterion.evidence?.id);
    assert.match(criterion.evidence?.stdout ?? '', /pass 1/);
    assert.ok(criterion.evidence?.command.includes('registration.test.mjs'));
  }
  const jsonPath = `.donegauge/runs/${report.runId}/report.json`;
  assert.deepEqual(await reportFrom(root, jsonPath), report);
  assert.match(
    await readFile(
      join(root, `.donegauge/runs/${report.runId}/report.md`),
      'utf8',
    ),
    /Evidence|stdout/,
  );
});

test('CLI mixed real project preserves PASS, FAIL, UNVERIFIED, ERROR independently', async (t) => {
  const root = await newRepo(t, 'node-registration');
  const result = await runCli(root, [
    'check',
    '--config',
    'donegauge.mixed.json',
    '--allow-run',
    '--json',
  ]);
  assert.equal(result.code, 2);
  const report = JSON.parse(result.stdout) as AcceptanceReport;
  assert.deepEqual(report.summary, {
    PASS: 1,
    FAIL: 1,
    UNVERIFIED: 1,
    ERROR: 1,
  });
  assert.equal(report.finalStatus, 'REVIEW REQUIRED');
  assert.match(
    report.criteria[1]?.evidence?.stdout ?? '',
    /false !== true|false == true|false/,
  );
  assert.equal(report.criteria[2]?.evidence, null);
  assert.equal(report.criteria[3]?.evidence?.state, 'spawn-error');
});

test('real Python Decimal and unittest example passes without installing Python packages', async (t) => {
  const root = await newRepo(t, 'python-cart');
  const result = await runCli(root, ['check', '--allow-run', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout) as AcceptanceReport;
  assert.equal(report.summary.PASS, 2);
  assert.equal(report.finalStatus, 'VERIFIED');
  assert.match(report.criteria[0]?.evidence?.stderr ?? '', /Ran 1 test/);
});

test('preview never executes configured commands and missing checks remain unverified', async (t) => {
  const root = await newRepo(t);
  await saveConfig(
    root,
    configWith([
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync('should-not-exist','bad')",
    ]),
  );
  const preview = await checkAcceptance({ cwd: root });
  assert.equal(preview.summary.UNVERIFIED, 1);
  assert.equal(preview.criteria[0]?.evidence, null);
  await assert.rejects(access(join(root, 'should-not-exist')));
  await saveConfig(root, configWith());
  assert.equal(
    (await checkAcceptance({ cwd: root, execute: true })).criteria[0]?.status,
    'UNVERIFIED',
  );
});

test('preflight prevents partial execution when another directory is invalid', async (t) => {
  const root = await newRepo(t);
  const config = configWith([
    process.execPath,
    '-e',
    "require('node:fs').writeFileSync('should-not-exist','bad')",
  ]);
  config.criteria.push({
    id: 'bad-dir',
    description: 'Invalid setup',
    check: { command: ['node', '--version'], cwd: 'missing-directory' },
  });
  await saveConfig(root, config);
  await assert.rejects(
    checkAcceptance({ cwd: root, execute: true }),
    /Check the path/,
  );
  await assert.rejects(access(join(root, 'should-not-exist')));
});

test('approved config digest is checked before commands can run', async (t) => {
  const root = await newRepo(t);
  await saveConfig(
    root,
    configWith([process.execPath, '-e', "console.log('checked')"]),
  );
  const approved = await loadConfig(root);
  await assert.rejects(
    checkAcceptance({
      cwd: root,
      execute: true,
      approvedConfigSha256: '0'.repeat(64),
    }),
    /approved SHA-256/,
  );
  assert.equal(
    (
      await checkAcceptance({
        cwd: root,
        execute: true,
        approvedConfigSha256: approved.sha256,
      })
    ).summary.PASS,
    1,
  );
});

test('workspace mutation during a passing check requires review', async (t) => {
  const root = await newRepo(t);
  await saveConfig(
    root,
    configWith([
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync('tracked.txt','changed'); console.log('done')",
    ]),
  );
  const report = await checkAcceptance({ cwd: root, execute: true });
  assert.equal(report.summary.PASS, 1);
  assert.equal(report.workspaceChangedDuringRun, true);
  assert.equal(report.finalStatus, 'REVIEW REQUIRED');
  assert.match(report.warnings.join(), /changed during/);
});

test('unresolved Git conflicts require review even when checks pass', async (t) => {
  const root = await newRepo(t);
  const tracked = join(root, 'tracked.txt');
  const otherTracked = join(root, 'delete.txt');
  await execGit(root, ['checkout', '-b', 'conflict-left']);
  await writeFile(tracked, 'left\n');
  await writeFile(otherTracked, 'left\n');
  await execGit(root, ['commit', '-qam', 'Left change']);
  await execGit(root, ['checkout', '-b', 'conflict-right', 'HEAD^']);
  await writeFile(tracked, 'right\n');
  await writeFile(otherTracked, 'right\n');
  await execGit(root, ['commit', '-qam', 'Right change']);
  await assert.rejects(execGit(root, ['merge', 'conflict-left']), { code: 1 });
  // Keep the index conflict while making the working file match HEAD.
  await writeFile(otherTracked, 'right\n');
  await saveConfig(root, configWith([process.execPath, '--version']));

  const result = await runCli(root, ['check', '--allow-run', '--json']);
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(result.stdout) as AcceptanceReport;
  assert.equal(report.summary.PASS, 1);
  assert.equal(report.workspaceChangedDuringRun, false);
  assert.equal(report.finalStatus, 'REVIEW REQUIRED');
  assert.match(report.warnings.join(), /unresolved/);
  assert.deepEqual(
    report.changes.files.filter((file) => file.status === 'unmerged'),
    [
      { path: 'delete.txt', status: 'unmerged', untracked: false },
      { path: 'tracked.txt', status: 'unmerged', untracked: false },
    ],
  );
});

test('CLI exit codes distinguish review, execution errors, usage and non-Git failures', async (t) => {
  const root = await newRepo(t);
  await saveConfig(root, configWith());
  assert.equal((await runCli(root, ['check'])).code, 1);
  await saveConfig(
    root,
    configWith([process.execPath, '-e', 'setInterval(()=>{},100)']),
  );
  const loaded = (await loadConfig(root)).config;
  if (loaded.criteria[0]?.check) loaded.criteria[0].check.timeoutMs = 50;
  await saveConfig(root, loaded);
  const timeout = await runCli(root, ['check', '--allow-run', '--json']);
  assert.equal(timeout.code, 2);
  assert.equal(
    (JSON.parse(timeout.stdout) as AcceptanceReport).criteria[0]?.evidence
      ?.state,
    'timed-out',
  );
  assert.equal((await runCli(root, ['check', '--bogus'])).code, 2);
  assert.match(
    (await runCli(await tempDirectory(t), ['check'])).stderr,
    /Git working tree/,
  );
});

test('init is usable and never overwrites existing configuration', async (t) => {
  const root = await tempDirectory(t);
  assert.equal((await runCli(root, ['--version'])).stdout.trim(), version);
  assert.ok(
    (await runCli(root, ['--help'])).stdout.startsWith(`DoneGauge ${version} `),
  );
  assert.equal((await runCli(root, ['init'])).code, 0);
  const before = await readFile(join(root, 'donegauge.json'), 'utf8');
  assert.equal((await runCli(root, ['init'])).code, 2);
  assert.equal(await readFile(join(root, 'donegauge.json'), 'utf8'), before);
});

test('report formats share real evidence, escape logs, and refuse overwrites or symlinks', async (t) => {
  const root = await newRepo(t);
  await saveConfig(
    root,
    configWith([
      process.execPath,
      '-e',
      "console.log('```\\n<script>log</script>\\n```'); console.log('\\x1b[31mred\\x1b[0m')",
    ]),
  );
  const report = await checkAcceptance({ cwd: root, execute: true });
  assert.equal(
    (JSON.parse(renderJson(report)) as AcceptanceReport).criteria[0]?.evidence
      ?.stdout,
    report.criteria[0]?.evidence?.stdout,
  );
  assert.match(renderMarkdown(report), /````text/);
  assert.ok(!renderTerminal(report).includes('\x1b'));
  const paths = await writeReports(root, report);
  assert.equal((await reportFrom(root, paths.json)).runId, report.runId);
  await assert.rejects(writeReports(root, report), /refusing to overwrite/);
  const outside = await tempDirectory(t);
  await symlink(outside, join(root, 'linked-reports'));
  await assert.rejects(
    writeReports(root, report, 'linked-reports'),
    /normal directory/,
  );
  await assert.rejects(
    writeReports(root, report, '../elsewhere'),
    /inside the project/,
  );
});
