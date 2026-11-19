import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolsService, type ToolExecutionInput } from '@deepseek-ai/dsh-tools';
import * as native from '@deepseek-ai/dsh-tool-executor-native';
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import { Session } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import {
  ApprovalService,
  type ApprovalOutcome,
} from '@deepseek-ai/dsh-user-approval';
import * as adapter from '../src/adapters/dsh/index.js';
import { readCardData } from '../src/adapters/dsh/card-data.js';
import { renderModelResult } from '../src/adapters/dsh/model-result.js';
import { loadConfig } from '../src/core/config.js';
import type { AcceptanceConfig, AcceptanceReport } from '../src/core/types.js';
import { configWith, newRepo, saveConfig, runCli } from './helpers.js';
import { renderMarkdown, renderTerminal } from '../src/reporters/index.js';

async function host(
  t: TestContext,
  config: adapter.DshConfig = {},
): Promise<Context> {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolsService).await();
  await ctx.plugin(native).await();
  await ctx.plugin(adapter, config).await();
  return ctx;
}

function call(
  ctx: Context,
  args: unknown = {},
  signal = new AbortController().signal,
) {
  return executeModelToolFixture(ctx, {
    callId: randomUUID() as ToolExecutionInput['callId'],
    name: 'donegauge_check',
    arguments: args,
    signal,
  });
}

function guidedCall(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: ToolExecutionInput['agent'],
  signal = new AbortController().signal,
) {
  return executeModelToolFixture(ctx, {
    callId: randomUUID() as ToolExecutionInput['callId'],
    name,
    arguments: args,
    ...(agent ? { agent } : {}),
    signal,
  });
}

test('guided DSH preview hands the same draft to CLI without running; only explicitly shared counts come back', async (t) => {
  const root = await newRepo(t, 'node-registration');
  const ctx = await host(t, { root, guidedReview: true });
  const missing = await guidedCall(ctx, 'donegauge_review', {});
  assert.match(JSON.stringify(missing), /paste the original requirement/);
  await assert.rejects(access(join(root, '.donegauge', 'reviews')));
  const elsewhere = await newRepo(t);
  const otherAgent = {
    session: { header: { cwd: elsewhere } },
  } as ToolExecutionInput['agent'];
  const wrongProject = await guidedCall(
    ctx,
    'donegauge_review',
    { task: 'login' },
    otherAgent,
  );
  assert.match(JSON.stringify(wrongProject), /not in the configured project/);
  await assert.rejects(access(join(root, '.donegauge', 'reviews')));
  const preview = await guidedCall(ctx, 'donegauge_review', {
    task: 'login after registration; manual requirement',
  });
  assert.equal(preview.isError, false, JSON.stringify(preview));
  if (preview.isError) return;
  const { draft, revision, canRequestApproval, runnable } = preview.value as {
    draft: string;
    revision: string;
    canRequestApproval: boolean;
    runnable: number;
  };
  assert.equal(runnable, 1);
  assert.equal(canRequestApproval, false);
  const refusal = await guidedCall(ctx, 'donegauge_review_run', {
    draft,
    revision,
  });
  assert.match(JSON.stringify(refusal), /No routable human approval/);
  await assert.rejects(access(join(root, '.donegauge', 'runs')));
  const cliPreview = JSON.parse(
    (await runCli(root, ['review', '--draft', draft, '--json'])).stdout,
  );
  assert.notEqual(revision, cliPreview.digest);
  const args = [
    'review',
    '--draft',
    draft,
    '--approve',
    cliPreview.digest,
    '--json',
  ];
  const privateResult = JSON.parse((await runCli(root, args)).stdout);
  assert.equal(
    (
      await guidedCall(ctx, 'donegauge_review_result', {
        draft,
        runId: privateResult.runId,
      })
    ).isError,
    true,
  );
  const completed = await runCli(root, [...args, '--share-with-dsh']);
  assert.equal(completed.code, 1, completed.stderr);
  const report = JSON.parse(completed.stdout);
  const shared = await guidedCall(ctx, 'donegauge_review_result', {
    draft,
    runId: report.runId,
  });
  assert.equal(shared.isError, false, JSON.stringify(shared));
  assert.match(
    JSON.stringify(shared),
    /REVIEW REQUIRED · PASS 1 \/ FAIL 0 \/ UNVERIFIED 1 \/ ERROR 0/,
  );
  assert.doesNotMatch(
    JSON.stringify(shared),
    /registration\.test\.mjs|stdoutSha256/,
  );
  const receiptPath = join(
    root,
    '.donegauge',
    'reviews',
    draft,
    'shared-' + report.runId + '.json',
  );
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  await writeFile(
    receiptPath,
    JSON.stringify({ ...receipt, finalStatus: 'VERIFIED' }),
  );
  assert.equal(
    (
      await guidedCall(ctx, 'donegauge_review_result', {
        draft,
        runId: report.runId,
      })
    ).isError,
    true,
  );
  for (const bad of [
    { draft: '../other', runId: report.runId },
    { draft, runId: '../other' },
  ])
    assert.equal(
      (await guidedCall(ctx, 'donegauge_review_result', bad)).isError,
      true,
    );
  const denied = ctx.on('tools/pre-execute', async () => ({
    kind: 'deny',
    reason: 'operator policy',
  }));
  assert.equal(
    (await guidedCall(ctx, 'donegauge_review', { task: 'new requirement' }))
      .isError,
    true,
  );
  denied();
});

test('guided native runs require a fresh allowed-once decision on the displayed commands and recheck the source afterwards', async (t) => {
  const root = await newRepo(t);
  const file = join(root, 'feature.test.mjs');
  const source =
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('target works',()=>assert.ok(true));\n";
  await writeFile(file, source);
  const ctx = await host(t, { root, guidedReview: true });
  await ctx.plugin(SessionProjectionRegistry).await();
  await ctx.plugin(ApprovalService, {}).await();
  const session = Session.create(
    randomUUID() as Parameters<typeof Session.create>[0],
  );
  session.append('turn/start', { turn: 1 });
  const agent = { session } as ToolExecutionInput['agent'];
  let decision: ApprovalOutcome = 'rejected';
  let during: (() => Promise<void>) | undefined;
  const prompts: string[] = [];
  ctx.on('approval/request', async (req) => {
    prompts.push(req.reason ?? '');
    await during?.();
    return decision;
  });
  const getRevision = async () => {
    const result = await guidedCall(
      ctx,
      'donegauge_review',
      { task: 'target works' },
      agent,
    );
    assert.equal(result.isError, false, JSON.stringify(result));
    if (result.isError) throw new Error('Missing preview');
    const { draft, revision, canRequestApproval } = result.value as {
      draft: string;
      revision: string;
      canRequestApproval: boolean;
    };
    assert.equal(canRequestApproval, true);
    return { draft, revision };
  };
  const args = await getRevision();
  const run = (data = args, signal?: AbortSignal) =>
    guidedCall(ctx, 'donegauge_review_run', data, agent, signal);
  assert.equal((await run({ ...args, revision: 'invalid' })).isError, true);
  assert.equal(prompts.length, 0);
  assert.equal((await run()).isError, true);
  assert.match(prompts[0]!, /--test-reporter=junit/);
  assert.ok(prompts[0]!.includes(args.revision));
  decision = 'allowed-once';
  during = () => writeFile(file, source + '\n');
  assert.equal((await run()).isError, true);
  await assert.rejects(access(join(root, '.donegauge', 'runs')));
  during = undefined;
  const allowed = await run(await getRevision());
  assert.equal(allowed.isError, false, JSON.stringify(allowed));
  assert.equal(readCardData(allowed.meta)?.finalStatus, 'VERIFIED');
  await writeFile(file, source.replace('assert.ok(true)', 'assert.ok(false)'));
  const failed = await run(await getRevision());
  assert.equal(
    readCardData(failed.meta)?.summary.FAIL,
    1,
    JSON.stringify(failed),
  );
  const controller = new AbortController();
  during = async () => {
    controller.abort();
  };
  assert.equal(
    (await run(await getRevision(), controller.signal)).isError,
    true,
  );
});

test('official DSH runtime registers and invokes real approved Node acceptance checks', async (t) => {
  const root = await newRepo(t, 'node-registration');
  const ctx = await host(t, {
    root,
    approvedConfigSha256: (await loadConfig(root)).sha256,
  });
  assert.deepEqual(
    ctx.tools.schemas().map((s) => s.name),
    ['donegauge_check'],
  );
  const result = await call(ctx);
  assert.equal(result.isError, false, JSON.stringify(result));
  if (result.isError) return;
  const value = result.value as unknown as {
    summary: { PASS: number };
    finalStatus: string;
    reports: { json: string };
    criteria: { evidenceId: string }[];
  };
  assert.equal(value.summary.PASS, 3);
  assert.equal(value.finalStatus, 'VERIFIED');
  const report = JSON.parse(
    await readFile(join(root, value.reports.json), 'utf8'),
  ) as AcceptanceReport;
  assert.equal(report.criteria[0]?.evidence?.id, value.criteria[0]?.evidenceId);
  assert.match(
    result.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
    /^VERIFIED · PASS 3 \/ FAIL 0 \/ UNVERIFIED 0 \/ ERROR 0/,
  );
});

test('DSH returns domain failures and execution errors as distinct structured statuses', async (t) => {
  const root = await newRepo(t, 'node-registration');
  const loaded = await loadConfig(root, 'donegauge.mixed.json');
  const ctx = await host(t, {
    root,
    configPath: 'donegauge.mixed.json',
    approvedConfigSha256: loaded.sha256,
  });
  const result = await call(ctx);
  assert.equal(result.isError, false, JSON.stringify(result));
  if (result.isError) return;
  const value = result.value as unknown as {
    summary: object;
    finalStatus: string;
    criteria: { status: string; evidenceId: string }[];
  };
  assert.deepEqual(value.summary, {
    PASS: 1,
    FAIL: 1,
    UNVERIFIED: 1,
    ERROR: 1,
  });
  assert.equal(value.finalStatus, 'REVIEW REQUIRED');
  const visual = readCardData(result.meta);
  assert.ok(
    visual,
    'The persisted DSH metadata should replay as an acceptance card.',
  );
  assert.deepEqual(visual.summary, value.summary);
  assert.deepEqual(
    visual.criteria.map((item) => [item.status, item.evidenceId]),
    value.criteria.map((item) => [item.status, item.evidenceId]),
  );
  assert.match(
    visual.criteria.find((item) => item.status === 'FAIL')?.execution ?? '',
    /exit 1/,
  );
  assert.equal(
    readCardData({
      ...visual,
      reports: { markdown: '../private.md', json: visual.reports.json },
    }),
    undefined,
  );
  const card = result.content
    .map((content) => (content.type === 'text' ? content.text : ''))
    .join('\n');
  for (const criterion of value.criteria) {
    if (criterion.status === 'UNVERIFIED') {
      assert.equal(criterion.evidenceId, '');
    } else {
      assert.ok(criterion.evidenceId);
      assert.ok(card.includes(`Evidence ID: ${criterion.evidenceId}`));
    }
  }
});

test('model output prioritizes review items and bounds diagnostic detail without changing totals', () => {
  const markdown = '.donegauge/runs/id/report.md';
  const json = '.donegauge/runs/id/report.json';
  const text = renderModelResult({
    finalStatus: 'REVIEW REQUIRED',
    summary: { PASS: 98, FAIL: 1, UNVERIFIED: 0, ERROR: 1 },
    criteria: [
      ...Array.from({ length: 98 }, (_, index) => ({
        id: `pass-${index}`,
        status: 'PASS' as const,
        evidenceId: `pass-id-${index}`,
        reason: 'Long passing-test detail',
      })),
      {
        id: 'failure',
        status: 'FAIL',
        evidenceId: 'fail-id',
        reason: 'Check exited 1; expected 0.',
      },
      {
        id: 'error',
        status: 'ERROR',
        evidenceId: 'error-id',
        reason: `Cannot start command\n${'x'.repeat(2000)}`,
      },
    ],
    reports: { markdown, json },
    warnings: ['Project changed during verification.'],
  });
  assert.match(
    text,
    /^REVIEW REQUIRED · PASS 98 \/ FAIL 1 \/ UNVERIFIED 0 \/ ERROR 1\n\[ERROR\] error/,
  );
  assert.match(
    text,
    /\[FAIL\] failure · Check exited 1; expected 0\. · Evidence ID: fail-id/,
  );
  assert.match(text, /Showing 8\/100 criteria/);
  assert.match(text, /Warning: Project changed during verification\./);
  assert.ok(text.includes(markdown) && text.includes(json));
  assert.doesNotMatch(text, /Long passing-test detail|pass-id-6|x{113}/);
  assert.ok(text.length < 900);
});

test('DSH tool rejects arbitrary model arguments and missing human approval', async (t) => {
  const ctx = await host(t);
  const notConfigured = await call(ctx);
  assert.equal(notConfigured.isError, true);
  assert.match(JSON.stringify(notConfigured), /not configured/);
  const injected = await call(ctx, { command: ['arbitrary-program'] });
  assert.equal(injected.isError, true);
  assert.match(JSON.stringify(injected), /accepts no arguments/);
});

test('changed DSH approval stops commands before starting', async (t) => {
  const root = await newRepo(t);
  await saveConfig(
    root,
    configWith([
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync('must-not-run','bad')",
    ]),
  );
  const ctx = await host(t, { root, approvedConfigSha256: '0'.repeat(64) });
  const result = await call(ctx);
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /approved SHA-256/);
  await assert.rejects(access(join(root, 'must-not-run')));
});

test('DSH policy denial and cancellation bypass tool execution', async (t) => {
  const root = await newRepo(t);
  await saveConfig(
    root,
    configWith([
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync('must-not-run','bad')",
    ]),
  );
  const ctx = await host(t, {
    root,
    approvedConfigSha256: (await loadConfig(root)).sha256,
  });
  ctx.on('tools/pre-execute', async () => ({
    kind: 'deny',
    reason: 'Denied by test deployment policy',
  }));
  const denied = await call(ctx);
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /Denied by test deployment policy/);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await call(ctx, {}, controller.signal)).isError, true);
  await assert.rejects(access(join(root, 'must-not-run')));
});

test('cancelling an in-flight DSH check does not produce a success report', async (t) => {
  const root = await newRepo(t);
  await saveConfig(
    root,
    configWith([
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync('check-started','yes');setInterval(()=>{},1000)",
    ]),
  );
  const ctx = await host(t, {
    root,
    approvedConfigSha256: (await loadConfig(root)).sha256,
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const resultPromise = call(ctx, {}, controller.signal);
  const started = join(root, 'check-started');
  const deadline = Date.now() + 5000;
  while (
    !(await access(started).then(
      () => true,
      () => false,
    ))
  ) {
    assert.ok(Date.now() < deadline, 'The underlying command never started.');
    await delay(25);
  }
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.isError, true);
  await assert.rejects(access(join(root, '.donegauge/runs')), {
    code: 'ENOENT',
  });
});

test('disposing plugin removes tool registration from official registry', async (t) => {
  const ctx = await host(t);
  assert.ok(ctx.tools.get('donegauge_check'));
  for (const fiber of ctx.registry.get(adapter)?.fibers ?? [])
    await fiber.dispose();
  assert.equal(ctx.tools.get('donegauge_check'), undefined);
});

test('DSH JUnit results agree with disk JSON, Markdown and terminal for all four statuses', async (t) => {
  const root = await newRepo(t);
  await writeFile(
    join(root, 'target.test.mjs'),
    `import {test} from 'node:test'; import assert from 'node:assert/strict'; test('passes',()=>assert.ok(true));test('fails',()=>assert.fail('real failure'));test.skip('skips',()=>{});`,
  );
  const config: AcceptanceConfig = {
    version: 1,
    task: 'JUnit through DSH',
    criteria: ['passes', 'fails', 'skips', 'error'].map((name) => ({
      id: name,
      description: `Verify ${name}`,
      check: {
        kind: 'junit',
        command:
          name === 'error'
            ? ['donegauge-missing-junit-executable']
            : [
                process.execPath,
                '--test',
                `--test-name-pattern=^${name}$`,
                '--test-reporter=junit',
                '--test-reporter-destination={evidenceDir}/junit.xml',
                'target.test.mjs',
              ],
        junit: { file: '{evidenceDir}/junit.xml', tests: [{ name }] },
      },
    })),
  };
  await saveConfig(root, config);
  const ctx = await host(t, {
    root,
    approvedConfigSha256: (await loadConfig(root)).sha256,
  });
  const result = await call(ctx);
  assert.equal(result.isError, false, JSON.stringify(result));
  if (result.isError) return;
  const value = result.value as unknown as {
    summary: object;
    reports: { json: string };
    criteria: {
      status: string;
      evidenceId: string;
      targetTests: number;
      executedTargetTests: number;
      testEvidencePath: string;
      targetTestResults: { name: string; outcome: string }[];
    }[];
  };
  const report = JSON.parse(
    await readFile(join(root, value.reports.json), 'utf8'),
  ) as AcceptanceReport;
  assert.deepEqual(value.summary, {
    PASS: 1,
    FAIL: 1,
    UNVERIFIED: 1,
    ERROR: 1,
  });
  for (const [index, criterion] of report.criteria.entries()) {
    const actual = value.criteria[index]!;
    assert.equal(actual.status, criterion.status);
    assert.equal(actual.evidenceId, criterion.evidence?.id);
    assert.equal(actual.targetTests, criterion.testEvidence?.counts.targets);
    assert.equal(
      actual.executedTargetTests,
      criterion.testEvidence?.counts.executedTargets,
    );
    assert.equal(actual.testEvidencePath, criterion.testEvidence?.source.path);
    if (criterion.status !== 'ERROR')
      assert.equal(actual.targetTestResults[0]?.name, criterion.id);
    for (const output of [renderMarkdown(report), renderTerminal(report)]) {
      assert.ok(output.includes(actual.evidenceId));
      assert.ok(output.includes(actual.testEvidencePath));
      assert.ok(output.includes(actual.status));
    }
  }
  const nativeText = result.content
    .map((content) => (content.type === 'text' ? content.text : ''))
    .join('');
  assert.ok(nativeText.includes(value.reports.json));
  assert.ok(
    !nativeText.includes('/junit.xml'),
    'The raw XML paths stay in structured output and the rendered card.',
  );
});
