import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DoneGaugeError } from './errors.js';
import { runCommand, type ProcessEvidence } from './runner.js';
import type { ChangedFile, GitChanges } from './types.js';

const gitEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
};
const unmergedStatusCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

async function git(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<ProcessEvidence> {
  signal?.throwIfAborted();
  const result = await runCommand(['git', ...args], root, {
    env: gitEnv,
    timeoutMs: 30_000,
    maxOutputBytes: 262_144,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  return result;
}

function requireGit(
  result: ProcessEvidence,
  help: string,
  allowTruncated = false,
): string {
  if (result.state !== 'exited' || result.exitCode !== 0) {
    throw new DoneGaugeError(
      `${help}\n${result.error ?? result.stderr.trim()}`,
      'GIT',
    );
  }
  if (result.outputTruncated && !allowTruncated) {
    throw new DoneGaugeError(
      'Git metadata is too large to collect safely (256 KiB). Narrow the task or remove unrelated untracked files.',
      'GIT',
    );
  }
  return result.stdout;
}

export async function repositoryRoot(
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await git(cwd, ['rev-parse', '--show-toplevel'], signal);
  const output = requireGit(
    result,
    'DoneGauge needs a Git working tree. Run from a repository or use --cwd /path/to/project. Install Git if it is missing.',
  );
  const path = output.endsWith('\n') ? output.slice(0, -1) : output;
  return realpath(path);
}

export function parseNameStatus(text: string): ChangedFile[] {
  const tokens = text.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length - 1; i += 2) {
    const code = tokens[i];
    const path = tokens[i + 1];
    if (!code || !path)
      throw new DoneGaugeError(
        'Git returned malformed file metadata. Retry with a cleanly readable working tree.',
        'GIT',
      );
    const status = (
      {
        A: 'added',
        M: 'modified',
        D: 'deleted',
        T: 'type-changed',
        U: 'unmerged',
      } as const
    )[code as 'A'];
    files.push({ path, status: status ?? 'unknown', untracked: false });
  }
  return files;
}

function workingStatus(text: string): {
  untracked: string[];
  unmerged: string[];
  fingerprint: string;
} {
  const tokens = text.split('\0');
  const untracked: string[] = [];
  const unmerged: string[] = [];
  const entries: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (
      code === '??' &&
      (path === '.donegauge' || path.startsWith('.donegauge/'))
    )
      continue;
    entries.push(entry);
    if (code === '??') untracked.push(path);
    if (unmergedStatusCodes.has(code)) unmerged.push(path);
    if (code.includes('R') || code.includes('C'))
      entries.push(tokens[++i] ?? '');
  }
  return { untracked, unmerged, fingerprint: entries.join('\0') };
}

async function untrackedHash(
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const absolute = join(root, path);
  const stats = await lstat(absolute);
  const hash = createHash('sha256');
  if (stats.isSymbolicLink()) hash.update(await readlink(absolute));
  else if (stats.isFile()) {
    const stream = createReadStream(absolute, signal ? { signal } : {});
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } else
    hash.update(`non-regular:${stats.mode}:${stats.size}:${stats.mtimeMs}`);
  return hash.digest('hex');
}

export async function collectChanges(
  root: string,
  base = 'HEAD',
  signal?: AbortSignal,
): Promise<GitChanges> {
  if (!base.trim() || base.startsWith('-') || base.includes('\0')) {
    throw new DoneGaugeError(
      'Invalid Git base. Use a commit or ref such as HEAD or main.',
      'GIT',
    );
  }
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'], signal);
  const headCommit = head.exitCode === 0 ? head.stdout.trim() : null;
  let baseCommit: string | null;
  let diffBase: string;
  if (!headCommit && base === 'HEAD') {
    baseCommit = null;
    // Hashing without -w does not modify the object database, and also works in SHA-256 repositories.
    diffBase = requireGit(
      await git(root, ['hash-object', '-t', 'tree', '--stdin'], signal),
      'Could not determine the empty-tree base.',
    ).trim();
  } else {
    baseCommit = requireGit(
      await git(
        root,
        ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
        signal,
      ),
      `Git base "${base}" is not a commit. Choose an existing commit/ref with --base.`,
    ).trim();
    diffBase = baseCommit;
  }
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const names = await git(
    root,
    [...diffArgs, '--name-status', '-z', diffBase, '--'],
    signal,
  );
  const files = parseNameStatus(
    requireGit(
      names,
      'Could not collect changed files. Resolve unreadable or conflicted Git state.',
    ),
  );
  const status = requireGit(
    await git(
      root,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ],
      signal,
    ),
    'Could not read working-tree status.',
  );
  const working = workingStatus(status);
  const untracked = working.untracked;
  if (working.unmerged.length > 0) {
    // A diff against a commit can report an unmerged path as modified or omit it.
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    for (const path of working.unmerged) {
      const file = filesByPath.get(path);
      if (file) file.status = 'unmerged';
      else files.push({ path, status: 'unmerged', untracked: false });
    }
  }
  const diffResult = await git(
    root,
    [...diffArgs, '--binary', '--full-index', diffBase, '--'],
    signal,
  );
  let diff = requireGit(diffResult, 'Could not collect the Git diff.', true);
  let diffTruncated = diffResult.outputTruncated;
  const fingerprint = createHash('sha256')
    .update(baseCommit ?? '')
    .update(headCommit ?? '')
    .update(working.fingerprint)
    .update(diffResult.stdoutSha256);
  for (const path of untracked) {
    signal?.throwIfAborted();
    files.push({ path, status: 'added', untracked: true });
    fingerprint.update(
      JSON.stringify([path, await untrackedHash(root, path, signal)]),
    );
    // Diff symlinks as links; Git --no-index never invokes user diff drivers here.
    if (Buffer.byteLength(diff) < 262_144) {
      const addition = await git(
        root,
        [
          'diff',
          '--no-index',
          '--no-ext-diff',
          '--no-textconv',
          '--binary',
          '--',
          '/dev/null',
          path,
        ],
        signal,
      );
      if (
        addition.state !== 'exited' ||
        ![0, 1].includes(addition.exitCode ?? -1)
      ) {
        throw new DoneGaugeError(
          `Could not collect untracked file "${path}": ${addition.error ?? addition.stderr}`,
          'GIT',
        );
      }
      const remaining = 262_144 - Buffer.byteLength(diff);
      diffTruncated ||=
        addition.outputTruncated ||
        Buffer.byteLength(addition.stdout) > remaining;
      diff += Buffer.from(addition.stdout)
        .subarray(0, remaining)
        .toString('utf8');
    } else diffTruncated = true;
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const counts = { added: 0, modified: 0, deleted: 0, other: 0 };
  for (const file of files) {
    if (
      file.status === 'added' ||
      file.status === 'modified' ||
      file.status === 'deleted'
    )
      counts[file.status]++;
    else counts.other++;
  }
  return {
    base,
    baseCommit,
    headCommit,
    files,
    summary: `${files.length} changed file(s): ${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted, ${counts.other} other. Includes staged, unstaged, and untracked files.`,
    diff,
    diffTruncated,
    fingerprint: fingerprint.digest('hex'),
  };
}
