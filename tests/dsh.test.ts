import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolsService, type ToolExecutionInput } from '@deepseek-ai/dsh-tools';
import * as native from '@deepseek-ai/dsh-tool-executor-native';
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import * as adapter from '../src/adapters/dsh/index.js';
import { loadConfig } from '../src/core/config.js';
import type { AcceptanceConfig, AcceptanceReport } from '../src/core/types.js';
import { configWith, newRepo, saveConfig } from './helpers.js';
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
    /3 verified/,
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
  const card = result.content
    .map((content) => (content.type === 'text' ? content.text : ''))
    .join('\n');
  for (const criterion of value.criteria) {
    if (criterion.status === 'UNVERIFIED') {
      assert.equal(criterion.evidenceId, '');
    } else {
      assert.ok(criterion.evidenceId);
      assert.ok(card.includes(`Evidence ID: ${criterion.evidenceId}.`));
    }
  }
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
});
