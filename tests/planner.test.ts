import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { createPlan } from '../src/review/plan.js';
import {
  prepareRequest,
  proposalFrom,
  requestProposal,
} from '../src/review/planner.js';
import { newRepo, runCli } from './helpers.js';

const env = {
  DONEGAUGE_PLANNER_MODEL: 'fixture',
  DONEGAUGE_PLANNER_URL: 'https://planner.example/chat/completions',
};
const parent = 'sample';
const plan = createPlan('Check login;Validate price', []);
const request = prepareRequest('/project', parent, plan, [], false, env);
const suggestion = {
  item: 1,
  criterion: 'Correct credentials allow login',
  candidateId: null,
  reason: 'No confirmed target',
};
const response = (entry: unknown) =>
  JSON.stringify({ suggestions: [entry], question: null });

test('the disclosure binds destination, model, parent and the full draft; locked and excluded text stays private', () => {
  const edited = structuredClone(plan);
  edited.items[1]!.locked = true;
  edited.items.push({
    description: 'secret excluded text',
    excluded: true,
    candidateId: null,
  });
  edited.items.push({
    description: 'secret bound text',
    excluded: false,
    candidateId: 'a'.repeat(24),
  });
  const preview = prepareRequest('/project', parent, edited, [], false, env);
  assert.deepEqual(preview.requirements, [{ item: 1, text: 'Check login' }]);
  assert.doesNotMatch(
    JSON.stringify(preview.body),
    /secret|Validate price|\/project/,
  );
  for (const other of [
    prepareRequest('/another', parent, plan, [], false, env),
    prepareRequest('/project', 'other', plan, [], false, env),
    preview,
    prepareRequest('/project', parent, plan, [], false, {
      ...env,
      DONEGAUGE_PLANNER_MODEL: 'other',
    }),
    prepareRequest('/project', parent, plan, [], false, {
      ...env,
      DONEGAUGE_PLANNER_URL: 'https://elsewhere.example/chat',
    }),
  ])
    assert.notEqual(other.digest, request.digest);
  for (const endpoint of [
    'http://nonlocal.example/chat',
    'https://secret@service.example/chat',
    'https://service.example/chat?key=secret',
  ])
    assert.throws(() =>
      prepareRequest('/project', parent, plan, [], false, {
        ...env,
        DONEGAUGE_PLANNER_URL: endpoint,
      }),
    );
});

test('proposals reject unknown IDs, commands, statuses, omitted fields and out-of-scope changes; untouched items survive', () => {
  const proposed = proposalFrom(response(suggestion), request, parent, plan);
  assert.deepEqual(proposed.items[1], plan.items[1]);
  assert.equal(proposed.items[0]?.basis?.source, plan.items[0]?.description);
  assert.equal(plan.items[0]?.description, 'Check login');
  for (const bad of [
    { ...suggestion, item: 3 },
    { ...suggestion, candidateId: 'a'.repeat(24) },
    { ...suggestion, command: ['echo'] },
    { ...suggestion, status: 'PASS' },
    { ...suggestion, reason: undefined },
    { ...suggestion, criterion: '\u001b[31m' },
  ])
    assert.throws(() => proposalFrom(response(bad), request, parent, plan));
  for (const bad of [
    '',
    'invalid',
    JSON.stringify({ question: null, suggestions: [] }),
  ])
    assert.throws(() => proposalFrom(bad, request, parent, plan));
});

test('planner transport refuses stale permission and missing credentials without fetching; time, size and completion are bounded', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response('');
  };
  await assert.rejects(
    requestProposal(request, 'not-approved', signal, {
      transport,
      key: 'test',
    }),
    /Disclosure changed/,
  );
  await assert.rejects(
    requestProposal(request, request.digest, signal, { transport }),
    /Nothing was sent/,
  );
  assert.equal(calls, 0);
  const slow: typeof fetch = async (_url, init) => {
    await once(init!.signal!, 'abort');
    throw new Error('aborted');
  };
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(
      requestProposal(request, request.digest, signal, {
        transport: slow,
        key: 'test',
        timeoutMs: 10,
      }),
      /timed out/,
    );
  } finally {
    clearTimeout(keepAlive);
  }
  for (const result of [
    new Response('x'.repeat(256 * 1024 + 1)),
    new Response('ignored', { status: 429 }),
    Response.json({
      choices: [{ finish_reason: 'length', message: { content: '{}' } }],
    }),
  ])
    await assert.rejects(
      requestProposal(request, request.digest, signal, {
        transport: async () => result,
        key: 'test',
      }),
    );
});

test('CLI sends exactly the approved projection once; saves a separate inspectable proposal, never executes or overwrites a draft', async (t) => {
  const root = await newRepo(t, 'node-registration');
  const calls: { body: string; auth: string | undefined }[] = [];
  let valid = true;
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    calls.push({ body, auth: incoming.headers.authorization });
    const context = JSON.parse(JSON.parse(body).messages[1].content);
    const target = context.tests.find(
      (candidate: { name: string }) =>
        candidate.name === 'login after registration',
    );
    outgoing.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                suggestions: [
                  { ...suggestion, candidateId: valid ? target.id : 'z' },
                  {
                    ...suggestion,
                    criterion: 'A weak password displays a clear message',
                    candidateId: null,
                  },
                ],
                question: 'Which password rule applies?',
              }),
            },
          },
        ],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const settings = {
    ...process.env,
    ...env,
    DONEGAUGE_PLANNER_URL:
      'http://127.0.0.1:' + address.port + '/chat/completions',
    DONEGAUGE_PLANNER_KEY: 'fixture-only',
  };
  const cli = (...args: string[]) =>
    runCli(root, ['review', '--json', ...args], settings);
  const first = await cli('--ai', '--task', '用户能登录，弱密码要给提示');
  assert.equal(first.code, 0, first.stderr);
  const disclosure = JSON.parse(first.stdout);
  assert.equal(disclosure.kind, 'planner-disclosure');
  assert.doesNotMatch(
    first.stdout,
    /fixture-only|registration\.test\.mjs|sourceSha256|test-reporter/,
  );
  const args = ['--ai', '--draft', disclosure.draft];
  const privatePreview = JSON.parse(
    (await cli(...args, '--omit-tests')).stdout,
  );
  assert.deepEqual(
    JSON.parse(privatePreview.body.messages[1].content).tests,
    [],
  );
  assert.notEqual(privatePreview.sendDigest, disclosure.sendDigest);
  assert.equal(
    (await cli(...args, '--omit-tests', '--send', disclosure.sendDigest)).code,
    2,
  );
  assert.equal(
    (await cli(...args, '--approve', disclosure.sendDigest)).code,
    2,
  );
  assert.equal(calls.length, 0);
  const oldPath = join(
    root,
    '.donegauge',
    'reviews',
    disclosure.draft,
    'plan.json',
  );
  const original = await readFile(oldPath, 'utf8');
  const result = await cli(...args, '--send', disclosure.sendDigest);
  assert.equal(result.code, 0, result.stderr);
  const proposed = JSON.parse(result.stdout);
  assert.equal(proposed.planner, 'model-proposal');
  assert.notEqual(proposed.draft, disclosure.draft);
  assert.equal(proposed.proposal.question, 'Which password rule applies?');
  assert.equal(proposed.items[0].test.file, 'registration.test.mjs');
  assert.equal(proposed.items[1].test, null);
  assert.equal(proposed.runnable, 1);
  assert.deepEqual(calls, [
    { body: JSON.stringify(disclosure.body), auth: 'Bearer fixture-only' },
  ]);
  assert.equal(
    JSON.parse((await cli('--draft', proposed.draft)).stdout).proposal.parent,
    disclosure.draft,
  );
  valid = false;
  const fallback = JSON.parse(
    (await cli(...args, '--send', disclosure.sendDigest)).stdout,
  );
  assert.equal(fallback.draft, disclosure.draft);
  assert.match(fallback.notice, /invalid proposal/);
  assert.equal(await readFile(oldPath, 'utf8'), original);
  const modified = JSON.parse(original);
  modified.items[0].description = 'New private requirement';
  await writeFile(oldPath, JSON.stringify(modified));
  assert.equal((await cli(...args, '--send', disclosure.sendDigest)).code, 2);
  assert.equal(calls.length, 2);
  await assert.rejects(access(join(root, '.donegauge', 'runs')));
});
