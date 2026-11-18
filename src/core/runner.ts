import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import type { ExecutionEvidence } from './types.js';
import { errorMessage } from './errors.js';

export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  displayCwd?: string;
}

export type ProcessEvidence = ExecutionEvidence;

export async function runCommand(
  command: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Promise<ProcessEvidence> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const limit = options.maxOutputBytes ?? 65_536;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let capturedBytes = 0;
  let state: ExecutionEvidence['state'] = 'exited';
  let error: string | null = null;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  const result = (): ProcessEvidence => ({
    id: randomUUID(),
    command: [...command],
    cwd: options.displayCwd ?? '.',
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    state,
    exitCode,
    signal: exitSignal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdoutBytes,
    stderrBytes,
    outputTruncated: stdoutBytes + stderrBytes > limit,
    error,
    stdoutSha256: stdoutHash.digest('hex'),
    stderrSha256: stderrHash.digest('hex'),
  });

  if (options.signal?.aborted) {
    state = 'aborted';
    error = 'Execution cancelled before starting.';
    return result();
  }
  const executable = command[0];
  if (!executable || !executable.trim()) {
    state = 'spawn-error';
    error = 'No executable configured.';
    return result();
  }

  await new Promise<void>((resolve) => {
    const environment = { ...(options.env ?? process.env) };
    // A parent node:test worker marks its descendants. Independent checks must
    // not inherit that internal marker, which makes nested `node --test` skip.
    delete environment.NODE_TEST_CONTEXT;
    // No shell expansion, pipes, redirects, or interpolation. Windows .cmd files
    // need an explicitly configured interpreter; they are not silently shelled.
    const onSpawnError = (err: unknown): void => {
      if (state === 'exited') {
        state = 'spawn-error';
        error = `Could not start ${executable}: ${errorMessage(err)}. Check the executable and working directory.`;
      }
    };
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(executable, command.slice(1), {
        cwd,
        env: environment,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      onSpawnError(err);
      resolve();
      return;
    }
    let escalation: NodeJS.Timeout | undefined;
    const killTree = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        /* The process group may already have exited. */
      }
    };
    const stop = (nextState: 'timed-out' | 'aborted'): void => {
      if (state !== 'exited') return;
      state = nextState;
      error =
        nextState === 'timed-out'
          ? `Command exceeded ${options.timeoutMs ?? 30_000} ms. Increase timeoutMs or fix the hanging check.`
          : 'Execution cancelled.';
      killTree('SIGTERM');
      escalation = setTimeout(() => killTree('SIGKILL'), 150);
    };
    const deadline = setTimeout(
      () => stop('timed-out'),
      options.timeoutMs ?? 30_000,
    );
    const onAbort = (): void => stop('aborted');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // Close the race between the pre-spawn check and listener registration.
    if (options.signal?.aborted) onAbort();
    const capture = (data: Buffer, target: Buffer[]): void => {
      const remaining = Math.max(0, limit - capturedBytes);
      const piece = data.subarray(0, remaining);
      if (piece.length) target.push(Buffer.from(piece));
      capturedBytes += piece.length;
    };
    child.stdout.on('data', (data: Buffer) => {
      stdoutBytes += data.length;
      stdoutHash.update(data);
      capture(data, stdout);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      stderrHash.update(data);
      capture(data, stderr);
    });
    child.on('error', onSpawnError);
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
      if (escalation) {
        clearTimeout(escalation);
        killTree('SIGKILL');
      }
      exitCode = state === 'spawn-error' ? null : code;
      exitSignal = signal;
      if (state === 'exited' && signal) {
        state = 'signaled';
        error = `Command terminated by ${signal}.`;
      }
      // Do not leave normal foreground checks' descendants running after exit.
      killTree('SIGKILL');
      resolve();
    });
  });
  return result();
}
