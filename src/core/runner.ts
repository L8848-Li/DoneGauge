import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { delimiter, join, resolve as absolutePath } from 'node:path';
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

function windowsProgram(name: string): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);
}

async function windowsBatchCommand(
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const [script, ...args] = command;
  if (
    !script ||
    command.some((arg) => /["%\r\n]/u.test(arg) || arg.includes('\0'))
  )
    throw new Error(
      'Explicit .cmd/.bat arguments cannot contain double quotes, percent signs or newlines. Invoke the underlying executable or JS entry point for those arguments.',
    );
  if (cwd.startsWith('\\\\'))
    throw new Error(
      'cmd.exe does not support UNC working directories. Use a native executable or JS entry point.',
    );
  const searchPath =
    Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ??
    '';
  const dirs = /[\\/:]/.test(script)
    ? [cwd]
    : [cwd, ...searchPath.split(delimiter)];
  for (const dir of dirs) {
    const candidate = absolutePath(cwd, dir.replace(/^"|"$/g, ''), script);
    if (!(await stat(candidate).catch(() => null))?.isFile()) continue;
    if (/["%\r\n]/u.test(candidate))
      throw new Error(
        'The resolved .cmd/.bat path contains unsupported cmd.exe quoting characters.',
      );
    const line = [candidate, ...args].map((arg) => `"${arg}"`).join(' ');
    return [windowsProgram('cmd.exe'), '/d', '/s', '/v:off', '/c', `"${line}"`];
  }
  throw new Error(`Batch script not found: ${script}`);
}

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
  let invocation = [...command];

  const result = (): ProcessEvidence => ({
    id: randomUUID(),
    command: invocation,
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

  const environment = { ...(options.env ?? process.env) };
  // Independent checks must not inherit the marker of the parent node:test worker.
  delete environment.NODE_TEST_CONTEXT;
  const windows = process.platform === 'win32';
  const batch = windows && /\.(?:cmd|bat)$/i.test(executable);
  if (batch) {
    try {
      invocation = await windowsBatchCommand(command, cwd, environment);
    } catch (err) {
      state = 'spawn-error';
      error = errorMessage(err);
      return result();
    }
    if (options.signal?.aborted) {
      state = 'aborted';
      error = 'Execution cancelled before starting.';
      return result();
    }
  }

  await new Promise<void>((resolve) => {
    const onSpawnError = (err: unknown): void => {
      if (state === 'exited') {
        state = 'spawn-error';
        error = `Could not start ${executable}: ${errorMessage(err)}. Check the executable and working directory.`;
      }
    };
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(invocation[0]!, invocation.slice(1), {
        cwd,
        env: environment,
        shell: false,
        detached: !windows,
        windowsVerbatimArguments: batch,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      onSpawnError(err);
      resolve();
      return;
    }
    let escalation: NodeJS.Timeout | undefined;
    let windowsCleanup: Promise<void> | undefined;
    const killTree = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
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
      if (windows && child.pid) {
        windowsCleanup = new Promise<void>((done) => {
          execFile(
            windowsProgram('taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            {
              windowsHide: true,
              timeout: 5_000,
            },
            (stopError) => {
              if (stopError) {
                error += ` Could not confirm Windows process-tree cleanup: ${errorMessage(stopError)}`;
                try {
                  child.kill('SIGKILL');
                } catch {
                  /* The parent may already have exited. */
                }
              }
              child.stdout.destroy();
              child.stderr.destroy();
              done();
            },
          );
        });
      } else if (!windows) {
        killTree('SIGTERM');
        escalation = setTimeout(() => killTree('SIGKILL'), 150);
      }
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
      if (!windows) killTree('SIGKILL');
      if (windowsCleanup) void windowsCleanup.then(resolve);
      else resolve();
    });
  });
  return result();
}
