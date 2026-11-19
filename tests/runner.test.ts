import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { evaluate } from '../src/core/evaluator.js';
import { runCommand } from '../src/core/runner.js';
import { tempDirectory } from './helpers.js';

test('review provider credentials are not inherited by check processes', async (t) => {
  const result = await runCommand(
    [
      process.execPath,
      '-e',
      "console.log(Object.keys(process.env).some(key => key.toUpperCase() === 'DONEGAUGE_PLANNER_KEY'))",
    ],
    await tempDirectory(t),
    {
      env: {
        ...process.env,
        DONEGAUGE_PLANNER_KEY: 'private',
        donegauge_planner_key: 'also-private',
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'false');
});

test('runs real assertion with timestamps, exit, command, and log', async (t) => {
  const command = [
    process.execPath,
    '-e',
    "require('node:assert/strict').equal(2+2,4); console.log('assertion-ok')",
  ];
  const result = await runCommand(command, await tempDirectory(t));
  assert.equal(result.state, 'exited');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.command, command);
  assert.match(result.stdout, /assertion-ok/);
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
  assert.equal(
    evaluate({ command, expect: { stdoutIncludes: 'assertion-ok' } }, result)
      .status,
    'PASS',
  );
});

test('nonzero assertion is FAIL; expected nonzero can pass an explicit contract', async (t) => {
  const command = [
    process.execPath,
    '-e',
    "require('node:assert/strict').equal(1,2)",
  ];
  const result = await runCommand(command, await tempDirectory(t));
  assert.equal(evaluate({ command }, result).status, 'FAIL');
  assert.equal(
    evaluate({ command, expect: { exitCode: 1 } }, result).status,
    'PASS',
  );
  assert.match(result.stderr, /AssertionError/);
});

test('missing executable is ERROR rather than FAIL', async (t) => {
  const result = await runCommand(
    ['donegauge-no-such-executable'],
    await tempDirectory(t),
  );
  assert.equal(result.state, 'spawn-error');
  assert.equal(result.exitCode, null);
  assert.equal(evaluate({ command: result.command }, result).status, 'ERROR');
  assert.match(result.error ?? '', /Check the executable/);
});

test('oversized arguments yield ERROR even when spawn throws synchronously', async (t) => {
  const command = [process.execPath, '--version', 'x'.repeat(2 * 1024 * 1024)];
  const result = await runCommand(command, await tempDirectory(t));
  assert.equal(result.state, 'spawn-error');
  assert.equal(result.exitCode, null);
  assert.equal(evaluate({ command }, result).status, 'ERROR');
  assert.match(result.error ?? '', /Could not start/);
});

test('timeout terminates a real long-running process', async (t) => {
  const result = await runCommand(
    [process.execPath, '-e', 'setInterval(()=>{},1000)'],
    await tempDirectory(t),
    { timeoutMs: 100 },
  );
  assert.equal(result.state, 'timed-out');
  assert.equal(evaluate({ command: result.command }, result).status, 'ERROR');
  assert.ok(result.durationMs < 4000);
});

test(
  'POSIX signal termination is an execution ERROR',
  { skip: process.platform === 'win32' },
  async (t) => {
    const result = await runCommand(
      [process.execPath, '-e', "process.kill(process.pid,'SIGTERM')"],
      await tempDirectory(t),
    );
    assert.equal(result.state, 'signaled');
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(evaluate({ command: result.command }, result).status, 'ERROR');
  },
);

test(
  'Windows native argv and explicit batch shims preserve their supported literal characters',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = join(await tempDirectory(t), '中文 worktree');
    await mkdir(root);
    const argv = ['中文 path', '%NAME%', 'a & b ! ^ | < >', 'literal "quote"'];
    const native = await runCommand(
      [
        process.execPath,
        '-e',
        'console.log(JSON.stringify(process.argv.slice(1)))',
        '--',
        ...argv,
      ],
      root,
    );
    assert.equal(native.exitCode, 0, JSON.stringify(native));
    assert.deepEqual(JSON.parse(native.stdout), argv);
    for (const ext of ['cmd', 'bat']) {
      const script = `tool smoke.${ext}`;
      await writeFile(join(root, script), '@echo off\r\necho "%~1"\r\n');
      const batch = await runCommand([script, argv[2]!], root);
      assert.equal(batch.exitCode, 0, JSON.stringify(batch));
      assert.match(batch.command[0]!, /cmd\.exe$/i);
      assert.equal(batch.stdout.trim(), `"${argv[2]}"`);
      assert.equal(
        (await runCommand([script, '%PATH%'], root)).state,
        'spawn-error',
      );
    }
  },
);

for (const stop of ['timeout', 'cancel'] as const) {
  test(
    `Windows ${stop} terminates the parent and its real descendant`,
    { skip: process.platform !== 'win32' },
    async (t) => {
      const root = await tempDirectory(t);
      const child =
        "console.log('child-ready');setTimeout(()=>require('node:fs').writeFileSync('late-write','escaped'),3300);setInterval(()=>{},1000)";
      const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
      const controller = new AbortController();
      const abortTimer =
        stop === 'cancel'
          ? setTimeout(() => controller.abort(), 1800)
          : undefined;
      try {
        const result = await runCommand(
          [process.execPath, '-e', parent],
          root,
          {
            timeoutMs: stop === 'timeout' ? 1800 : 10000,
            signal: controller.signal,
          },
        );
        assert.equal(
          result.state,
          stop === 'timeout' ? 'timed-out' : 'aborted',
        );
        assert.match(result.stdout, /child-ready/);
        assert.doesNotMatch(result.error ?? '', /Could not confirm/);
        await delay(2200);
        await assert.rejects(access(join(root, 'late-write')));
      } finally {
        clearTimeout(abortTimer);
      }
    },
  );
}

test('output is bounded, with original byte counts and truthful unknown result', async (t) => {
  const command = [
    process.execPath,
    '-e',
    "process.stdout.write('x'.repeat(10000)+'TAIL'); process.stderr.write('errors')",
  ];
  const result = await runCommand(command, await tempDirectory(t), {
    maxOutputBytes: 256,
  });
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdoutBytes, 10004);
  assert.equal(result.stderrBytes, 6);
  assert.ok(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 256,
  );
  assert.equal(
    evaluate({ command, expect: { stdoutIncludes: 'TAIL' } }, result).status,
    'UNVERIFIED',
  );
  assert.equal(
    evaluate({ command, expect: { stdoutIncludes: 'xxx' } }, result).status,
    'PASS',
  );
});

test('missing expected text in complete output is FAIL', async (t) => {
  const command = [
    process.execPath,
    '-e',
    "console.log('no assertions executed')",
  ];
  const result = await runCommand(command, await tempDirectory(t));
  assert.equal(
    evaluate({ command, expect: { stdoutIncludes: 'assertion-ok' } }, result)
      .status,
    'FAIL',
  );
});

test('a missing token in a complete stream is conclusive even when the other stream is truncated', async (t) => {
  const root = await tempDirectory(t);
  const command = [
    process.execPath,
    '-e',
    "process.stdout.write('x'.repeat(1024))",
  ];
  const result = await runCommand(command, root, { maxOutputBytes: 256 });
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, false);
  const check = {
    command,
    expect: { stdoutIncludes: 'tail', stderrIncludes: 'error' },
  };
  const verdict = evaluate(check, result);
  assert.equal(verdict.status, 'FAIL');
  assert.match(verdict.reason, /stderr/);
  const legacy = { ...result };
  delete legacy.stdoutTruncated;
  delete legacy.stderrTruncated;
  assert.equal(evaluate(check, legacy).status, 'UNVERIFIED');
});

test('shell operators passed as arguments stay literal', async (t) => {
  const root = await tempDirectory(t);
  const literal = '$(touch injected); touch injected && echo bad';
  const result = await runCommand(
    [process.execPath, '-e', 'console.log(process.argv[1])', literal],
    root,
  );
  assert.equal(result.stdout.trim(), literal);
  await assert.rejects(access(join(root, 'injected')));
});

test('pre-aborted and in-flight cancellation stop work', async (t) => {
  const root = await tempDirectory(t);
  const command = [process.execPath, '-e', 'setInterval(()=>{},1000)'];
  const before = new AbortController();
  before.abort();
  assert.equal(
    (await runCommand(command, root, { signal: before.signal })).state,
    'aborted',
  );
  const during = new AbortController();
  const work = runCommand(command, root, { signal: during.signal });
  setTimeout(() => during.abort(), 50);
  assert.equal((await work).state, 'aborted');
});

test(
  'POSIX timeout kills descendants and inherited output pipes',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await tempDirectory(t);
    const child =
      "setTimeout(()=>require('node:fs').writeFileSync('leaked','bad'),500);setInterval(()=>{},1000)";
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
    const result = await runCommand([process.execPath, '-e', parent], root, {
      timeoutMs: 200,
    });
    assert.equal(result.state, 'timed-out');
    await delay(600);
    await assert.rejects(access(join(root, 'leaked')));
  },
);
