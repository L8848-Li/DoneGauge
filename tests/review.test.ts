import assert from 'node:assert/strict';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { AcceptanceReport } from '../src/core/types.js';
import type { Candidate } from '../src/review/discovery.js';
import { newRepo, runCli } from './helpers.js';

interface Preview {
  kind: string;
  digest: string;
  draft: string;
  runnable: number;
  candidates: Candidate[];
  items: {
    description: string;
    candidateId: string | null;
    test: Candidate | null;
    suggestions: { id: string }[];
    excluded: boolean;
  }[];
}

async function preview(root: string, ...args: string[]): Promise<Preview> {
  const response = await runCli(root, ['review', ...args, '--json']);
  assert.equal(response.code, 0, response.stderr);
  return JSON.parse(response.stdout) as Preview;
}
const runApproved = (root: string, draft: Preview) =>
  runCli(root, [
    'review',
    '--draft',
    draft.draft,
    '--approve',
    draft.digest,
    '--json',
  ]);

test('local Node review: preview only, bilingual hints stay unverified, approval produces real evidence', async (t) => {
  const root = await newRepo(t, 'node-registration');
  const configPath = join(root, 'donegauge.json');
  const initial = await readFile(configPath);
  const plan = await preview(
    root,
    '--task',
    'duplicate email is rejected；注册后可以登录；弱密码提示',
  );
  assert.equal(plan.kind, 'review-preview');
  assert.equal(plan.runnable, 1);
  assert.ok(plan.items[1]?.suggestions.length);
  assert.equal(plan.items[1]?.test, null);
  assert.equal(plan.items[2]?.test, null);
  await assert.rejects(access(join(root, '.donegauge', 'runs')));
  const run = await runApproved(root, plan);
  assert.equal(run.code, 1, run.stderr);
  const report = JSON.parse(run.stdout) as AcceptanceReport;
  assert.equal(report.finalStatus, 'REVIEW REQUIRED');
  assert.deepEqual(
    report.criteria.map((item) => item.status),
    ['PASS', 'UNVERIFIED', 'UNVERIFIED'],
  );
  assert.equal(report.criteria[0]!.testEvidence?.counts.executedTargets, 1);
  assert.equal(report.workspaceChangedDuringRun, false);
  assert.deepEqual(await readFile(configPath), initial);
});

test('review Python checks use fresh pytest evidence and no project configuration is required', async (t) => {
  const root = await newRepo(t);
  await writeFile(
    join(root, 'test_math.py'),
    'import unittest\nclass MathTests(unittest.TestCase):\n    def test_exact_total(self):\n        self.assertEqual(2+2,4)\n',
  );
  const plan = await preview(root, '--task', 'exact total');
  assert.equal(plan.runnable, 1);
  const run = await runApproved(root, plan);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.equal(
    (JSON.parse(run.stdout) as AcceptanceReport).criteria[0]?.testEvidence
      ?.cases[0]?.name,
    'test_exact_total',
  );
});

test('edited drafts and changed test files invalidate approval; preview and denial have no test side effects', async (t) => {
  const root = await newRepo(t);
  const path = join(root, 'target.test.mjs');
  const source = `import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('executed.txt','yes');\ntest('my test', () => {});\n`;
  await writeFile(path, source);
  const initial = await preview(root, '--task', 'my test');
  const planPath = join(
    root,
    '.donegauge',
    'reviews',
    initial.draft,
    'plan.json',
  );
  const edit = JSON.parse(await readFile(planPath, 'utf8'));
  edit.items[0].description = 'User-confirmed behavior';
  await writeFile(planPath, JSON.stringify(edit));
  const stale = await runApproved(root, initial);
  assert.equal(stale.code, 2);
  assert.match(stale.stderr, /differs from the reviewed preview/);
  const updated = await preview(root, '--draft', initial.draft);
  assert.equal(updated.items[0]?.description, 'User-confirmed behavior');
  assert.notEqual(updated.digest, initial.digest);
  await writeFile(path, source + '\n');
  assert.equal((await runApproved(root, updated)).code, 2);
  assert.equal(
    (await runCli(root, ['review', '--draft', initial.draft, '--allow-run']))
      .code,
    2,
  );
  await assert.rejects(access(join(root, 'executed.txt')));
  await assert.rejects(access(join(root, '.donegauge', 'runs')));
  assert.deepEqual(
    await readdir(join(root, '.donegauge', 'reviews', initial.draft)),
    ['plan.json'],
  );
});

test('same-name tests need manual binding, excluded items do not turn green, and drafts cannot add commands', async (t) => {
  const root = await newRepo(t, 'node-registration');
  await mkdir(join(root, 'subproject'));
  await copyFile(
    join(root, 'registration.test.mjs'),
    join(root, 'subproject', 'copy.test.mjs'),
  );
  const initial = await preview(
    root,
    '--task',
    'login after registration; manual item',
  );
  assert.equal(initial.runnable, 0);
  assert.equal((await runApproved(root, initial)).code, 2);
  const planPath = join(
    root,
    '.donegauge',
    'reviews',
    initial.draft,
    'plan.json',
  );
  const edit = JSON.parse(await readFile(planPath, 'utf8'));
  edit.items[0].candidateId = initial.candidates.find(
    (candidate) =>
      candidate.file === 'registration.test.mjs' &&
      candidate.name === 'login after registration',
  )!.id;
  edit.items[1].excluded = true;
  await writeFile(planPath, JSON.stringify(edit));
  const updated = await preview(root, '--draft', initial.draft);
  assert.equal(updated.runnable, 1);
  const run = await runApproved(root, updated);
  assert.equal(run.code, 1, run.stderr);
  assert.equal(
    (JSON.parse(run.stdout) as AcceptanceReport).criteria[1]?.status,
    'UNVERIFIED',
  );
  edit.items[0].command = ['node', '--version'];
  await writeFile(planPath, JSON.stringify(edit));
  assert.equal((await runApproved(root, updated)).code, 2);
  assert.equal(
    (await runCli(root, ['review', '--draft', '..', '--json'])).code,
    2,
  );
});
