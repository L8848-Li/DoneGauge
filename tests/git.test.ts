import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectChanges, repositoryRoot } from '../src/core/git.js';
import { execGit, newRepo, tempDirectory } from './helpers.js';

test('collects staged, unstaged, deleted, and unusual untracked paths without changing index', async (t) => {
  const root = await newRepo(t);
  await writeFile(join(root, 'tracked.txt'), 'working change\n');
  await rm(join(root, 'delete.txt'));
  await writeFile(join(root, 'staged.txt'), 'staged\n');
  await execGit(root, ['add', '--', 'staged.txt']);
  const unusual =
    process.platform === 'win32' ? 'new 中文 name.txt' : 'new 中文\nname.txt';
  await writeFile(join(root, unusual), 'untracked content\r\n');
  const before = await readFile(join(root, '.git/index'));
  const changes = await collectChanges(root);
  assert.deepEqual(
    changes.files.map((f) => [f.path, f.status, f.untracked]),
    [
      ['delete.txt', 'deleted', false],
      [unusual, 'added', true],
      ['staged.txt', 'added', false],
      ['tracked.txt', 'modified', false],
    ],
  );
  assert.match(changes.diff, /working change/);
  assert.match(changes.diff, /untracked content/);
  assert.deepEqual(await readFile(join(root, '.git/index')), before);
  assert.equal(
    await execGit(root, ['rev-parse', 'HEAD']),
    changes.headCommit + '\n',
  );
});

test('supports alternate bases and rejects invalid refs', async (t) => {
  const root = await newRepo(t);
  const base = (await execGit(root, ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(root, 'tracked.txt'), 'committed update\n');
  await execGit(root, ['add', '--', 'tracked.txt']);
  await execGit(root, ['commit', '-qm', 'Change fixture']);
  assert.equal((await collectChanges(root)).files.length, 0);
  assert.equal(
    (await collectChanges(root, base)).files[0]?.path,
    'tracked.txt',
  );
  await assert.rejects(collectChanges(root, 'does-not-exist'), /not a commit/);
  await assert.rejects(
    collectChanges(root, '--output=/tmp/bad'),
    /Invalid Git base/,
  );
});

test('supports unborn Git and excludes untracked report storage', async (t) => {
  const root = await tempDirectory(t);
  await execGit(root, ['init', '-q']);
  await writeFile(join(root, 'new.txt'), 'new\n');
  await mkdir(join(root, '.donegauge'));
  await writeFile(join(root, '.donegauge', 'report.json'), '{}');
  const changes = await collectChanges(root);
  assert.equal(changes.baseCommit, null);
  assert.equal(changes.headCommit, null);
  assert.deepEqual(
    changes.files.map((f) => f.path),
    ['new.txt'],
  );
});

test('non-Git directory gives actionable error', async (t) => {
  await assert.rejects(
    repositoryRoot(await tempDirectory(t)),
    /needs a Git working tree/,
  );
});

test('fingerprint detects untracked binary content edits', async (t) => {
  const root = await newRepo(t);
  await writeFile(join(root, 'new.bin'), Buffer.from([0, 1, 2]));
  const before = await collectChanges(root);
  await writeFile(join(root, 'new.bin'), Buffer.from([0, 1, 3]));
  const after = await collectChanges(root);
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.match(after.diff, /GIT binary patch/);
});

test('Git never invokes configured external diff programs', async (t) => {
  const root = await newRepo(t);
  await execGit(root, [
    'config',
    'diff.external',
    'donegauge-this-must-not-run',
  ]);
  await writeFile(join(root, 'tracked.txt'), 'change\n');
  assert.match((await collectChanges(root)).diff, /change/);
});

test('reserved untracked evidence storage does not change the workspace fingerprint', async (t) => {
  const root = await tempDirectory(t);
  await execGit(root, ['init', '-q']);
  await writeFile(join(root, 'file.txt'), 'project content');
  const before = await collectChanges(root);
  await mkdir(join(root, '.donegauge'));
  await writeFile(
    join(root, '.donegauge', 'report.json'),
    '{"evidence":"new"}',
  );
  assert.equal((await collectChanges(root)).fingerprint, before.fingerprint);
});

test('truncated tracked diff still detects content changes beyond its retained prefix', async (t) => {
  const root = await newRepo(t);
  await writeFile(join(root, 'tracked.txt'), 'x'.repeat(300_000) + 'first\n');
  const before = await collectChanges(root);
  assert.equal(before.diffTruncated, true);
  await writeFile(join(root, 'tracked.txt'), 'x'.repeat(300_000) + 'other\n');
  const after = await collectChanges(root);
  // Git's index header contains a full content hash and therefore changes;
  // the retained hunk itself ends before the edited suffix in both snapshots.
  assert.ok(
    after.diff.slice(after.diff.indexOf('---')) ===
      before.diff.slice(before.diff.indexOf('---')),
    'The retained hunk should end before the edited suffix.',
  );
  assert.notEqual(after.fingerprint, before.fingerprint);
});
