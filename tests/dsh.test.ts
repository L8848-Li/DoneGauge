import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolsService, type ToolExecutionInput } from '@deepseek-ai/dsh-tools';
import * as native from '@deepseek-ai/dsh-tool-executor-native';
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import * as adapter from '../src/adapters/dsh/index.js';
import { loadConfig } from '../src/core/config.js';
import type { AcceptanceReport } from '../src/core/types.js';
import { configWith, newRepo, saveConfig } from './helpers.js';

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
  };
  assert.deepEqual(value.summary, {
    PASS: 1,
    FAIL: 1,
    UNVERIFIED: 1,
    ERROR: 1,
  });
  assert.equal(value.finalStatus, 'REVIEW REQUIRED');
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
