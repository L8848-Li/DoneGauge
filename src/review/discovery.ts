import { lstat, realpath, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { sha256 } from '../core/config.js';
import { DoneGaugeError } from '../core/errors.js';
import { runCommand } from '../core/runner.js';
import type { JunitCheck } from '../core/types.js';

export interface Candidate {
  id: string;
  file: string;
  name: string;
  line: number;
  sourceSha256: string;
  check: JunitCheck;
}

const sourceLimit = 64 * 1024;
const maxBytes = 2 * 1024 * 1024;
const ignored = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'vendor',
  'venv',
  '__pycache__',
]);

export async function discoverTests(root: string, signal: AbortSignal) {
  const listing = await runCommand(
    [
      'git',
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '*.test.js',
      '*.test.cjs',
      '*.test.mjs',
      '*.spec.js',
      '*.spec.cjs',
      '*.spec.mjs',
      'test_*.py',
      '*/test_*.py',
      '*_test.py',
    ],
    root,
    { signal, maxOutputBytes: 256 * 1024 },
  );
  signal.throwIfAborted();
  if (listing.state !== 'exited' || listing.exitCode !== 0)
    throw new DoneGaugeError('Cannot list project tests with Git.', 'GIT');
  const paths = [...new Set(listing.stdout.split('\0').slice(0, -1))]
    .filter(
      (file) =>
        !file
          .split('/')
          .some((part) => part.startsWith('.') || ignored.has(part)),
    )
    .sort();
  const candidates: Candidate[] = [];
  let bytes = 0;
  let incomplete = listing.outputTruncated || paths.length > 160;
  for (const file of paths.slice(0, 160)) {
    signal.throwIfAborted();
    const absolute = join(root, file);
    const info = await lstat(absolute).catch(() => null);
    if (
      !info?.isFile() ||
      (await realpath(absolute).catch(() => null)) !== absolute ||
      info.size > sourceLimit ||
      bytes + info.size > maxBytes
    ) {
      incomplete = true;
      continue;
    }
    const handle = await open(absolute, 'r');
    const data = Buffer.alloc(info.size + 1);
    let length = 0;
    try {
      while (length < data.length) {
        const { bytesRead } = await handle.read(
          data,
          length,
          data.length - length,
          null,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
    } finally {
      await handle.close();
    }
    bytes += length;
    if (length !== info.size) {
      incomplete = true;
      continue;
    }
    const source = data.subarray(0, length);
    const text = source.toString('utf8');
    const python = file.endsWith('.py');
    if (!python && !/['"]node:test['"]/.test(text)) continue;
    const sourceSha256 = sha256(source);
    const lines = text.split('\n');
    const names = new Set<string>();
    for (const [index, line] of lines.entries()) {
      const name = python
        ? /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/u.exec(line)?.[1]
        : /^\s*(?:test|it)\(\s*(['"])([^'"\\]+)\1\s*,/u.exec(line)?.[2];
      if (
        !name ||
        names.has(name) ||
        name.length > 2000 ||
        name.includes('{evidenceDir}')
      )
        continue;
      names.add(name);
      const xml = '{evidenceDir}/junit.xml';
      const target = `./${basename(file)}`;
      if (target.includes('{evidenceDir}') || dirname(file).length > 1000) {
        incomplete = true;
        continue;
      }
      const command = python
        ? [
            process.env.DONEGAUGE_PYTHON ??
              (process.platform === 'win32' ? 'python' : 'python3'),
            '-B',
            '-m',
            'pytest',
            '-p',
            'no:cacheprovider',
            '-q',
            `--junitxml=${xml}`,
            '-k',
            name,
            '--',
            target,
          ]
        : [
            process.versions.electron ? 'node' : process.execPath,
            '--test',
            '--test-reporter=junit',
            `--test-reporter-destination=${xml}`,
            `--test-name-pattern=^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            '--',
            target,
          ];
      candidates.push({
        id: sha256(JSON.stringify([file, name])).slice(0, 24),
        file,
        name,
        line: index + 1,
        sourceSha256,
        check: {
          kind: 'junit',
          command,
          cwd: dirname(file),
          junit: { file: xml, tests: [{ name }] },
        },
      });
      if (candidates.length >= 400) return { candidates, incomplete: true };
    }
  }
  return { candidates, incomplete };
}
