import sax from 'sax';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isWithin, sha256 } from './config.js';
import type { TestCaseEvidence } from './types.js';

export const JUNIT_LIMITS = {
  bytes: 10 * 1024 * 1024,
  depth: 50,
  cases: 50_000,
};

// SAX never fetches external resources. Reject all DTD/SGML declarations and
// restrict entities to XML's five built-ins rather than SAX's HTML entity set.
export function parseJunit(xml: string): {
  cases: TestCaseEvidence[];
  problems: string[];
} {
  if (Buffer.byteLength(xml) > JUNIT_LIMITS.bytes)
    throw new Error('JUnit XML exceeds 10 MiB.');
  const parser = sax.parser(true, { position: true });
  parser.ENTITIES = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
  const reject = (): never => {
    throw new Error(
      'JUnit DTD, entity declarations and processing instructions are disabled.',
    );
  };
  parser.ondoctype = reject;
  parser.onsgmldeclaration = reject;
  parser.onprocessinginstruction = ({ name, body }) => {
    if (name !== 'xml' || !/^version\s*=/.test(body)) reject();
    if (/encoding\s*=\s*["'](?!utf-8["'])/i.test(body))
      throw new Error('JUnit XML must use UTF-8.');
  };
  parser.onerror = (error) => {
    throw error;
  };
  type Frame = {
    tag: string;
    attrs: Record<string, string>;
    start: number;
    test?: TestCaseEvidence;
    detail?: TestCaseEvidence['details'][number];
  };
  const stack: Frame[] = [];
  const cases: TestCaseEvidence[] = [];
  const problems = new Set<string>();
  let seen = 0;
  let roots = 0;
  const numeric = (
    value: string | undefined,
    label: string,
    integer = false,
  ): number | null => {
    if (value === undefined) return null;
    const number = Number(value);
    if (
      !value.trim() ||
      !Number.isFinite(number) ||
      number < 0 ||
      (integer && !Number.isInteger(number))
    )
      throw new Error(`Invalid JUnit ${label}: ${value}.`);
    return number;
  };
  parser.onopentag = (tag) => {
    if (stack.length >= JUNIT_LIMITS.depth)
      throw new Error('JUnit XML exceeds 50 levels.');
    const attrs = tag.attributes as Record<string, string>;
    const parent = stack.at(-1);
    if (!parent && ++roots > 1)
      throw new Error('JUnit XML must contain one root.');
    if (
      /rerun|flaky|retr(?:y|ies)/i.test(tag.name) ||
      Object.keys(attrs).some((key) => /rerun|flaky|retr(?:y|ies)/i.test(key))
    )
      problems.add('Unsupported retry/flaky evidence requires review.');
    if (!parent && !['testsuite', 'testsuites'].includes(tag.name))
      throw new Error('JUnit root must be testsuite or testsuites.');
    const frame: Frame = { tag: tag.name, attrs, start: cases.length };
    if (['testsuite', 'testsuites'].includes(tag.name)) {
      numeric(attrs.time, 'suite time');
      if (
        attrs.status &&
        !['run', 'completed', 'passed'].includes(attrs.status.toLowerCase())
      )
        problems.add(`Suite status requires review: ${attrs.status}.`);
    }
    if (
      parent?.test &&
      ![
        'failure',
        'error',
        'skipped',
        'properties',
        'system-out',
        'system-err',
      ].includes(tag.name)
    )
      problems.add(`Unsupported testcase element: ${tag.name}.`);
    if (tag.name === 'testcase') {
      if (!parent || !['testsuite', 'testsuites'].includes(parent.tag))
        throw new Error('JUnit testcase must be a direct child of a suite.');
      if (++seen > JUNIT_LIMITS.cases)
        throw new Error('JUnit XML exceeds 50000 test cases.');
      if (!attrs.name?.trim())
        throw new Error('JUnit testcase is missing its name.');
      const duration = numeric(attrs.time, 'time');
      if (duration !== null && !Number.isFinite(duration * 1000))
        throw new Error('Invalid JUnit duration.');
      frame.test = {
        name: attrs.name,
        className: attrs.classname ?? null,
        suite: stack
          .filter((f) => f.tag === 'testsuite')
          .map((f) => f.attrs.name ?? ''),
        file: attrs.file ?? null,
        line: numeric(attrs.line, 'line', true),
        durationMs: duration === null ? null : duration * 1000,
        outcome: 'passed',
        details: [],
        reportLine: parser.line + 1,
      };
      const status = attrs.status?.toLowerCase();
      const result = attrs.result?.toLowerCase();
      if (
        ['notrun', 'disabled', 'skipped', 'skip', 'todo'].includes(
          status ?? '',
        ) ||
        ['suppressed', 'skipped'].includes(result ?? '')
      )
        frame.test.outcome = 'skipped';
      else if (
        (status && !['run', 'passed', 'completed'].includes(status)) ||
        (result && result !== 'completed')
      ) {
        frame.test.outcome = 'unverified';
        problems.add(
          `Unsupported testcase status/result: ${status ?? ''}/${result ?? ''}.`,
        );
      }
      // Node emits a file-path testcase when a name filter selected no tests.
      const normalizedName = attrs.name.replaceAll('\\', '/');
      const normalizedFile = attrs.file?.replaceAll('\\', '/');
      if (
        normalizedFile &&
        (normalizedFile === normalizedName ||
          normalizedFile.endsWith(`/${normalizedName}`))
      )
        frame.test.outcome = 'unverified';
    } else if (
      ['testsuite', 'testsuites'].includes(tag.name) &&
      parent &&
      !['testsuite', 'testsuites'].includes(parent.tag)
    ) {
      throw new Error('JUnit suites must be nested directly in suites.');
    } else if (['failure', 'error', 'skipped'].includes(tag.name)) {
      if (!parent?.test) throw new Error(`JUnit ${tag.name} outside testcase.`);
      const outcome =
        tag.name === 'failure'
          ? /cancelled|timeout|hookFailed/i.test(attrs.type ?? '')
            ? 'error'
            : 'failed'
          : tag.name === 'error'
            ? 'error'
            : 'skipped';
      if (
        parent.test.details.some((d) =>
          ['failure', 'error', 'skipped'].includes(d.kind),
        ) ||
        (parent.test.outcome === 'skipped' && outcome !== 'skipped')
      )
        throw new Error('Contradictory or repeated JUnit testcase outcomes.');
      parent.test.outcome = outcome;
      frame.detail = {
        kind: tag.name,
        type: attrs.type ?? null,
        message: attrs.message ?? '',
        text: '',
      };
      parent.test.details.push(frame.detail);
    } else if (parent?.test && /rerun|flaky|retr(?:y|ies)/i.test(tag.name)) {
      frame.detail = {
        kind: tag.name,
        type: attrs.type ?? null,
        message: attrs.message ?? '',
        text: '',
      };
      parent.test.details.push(frame.detail);
    }
    // Do not accept hidden testcases under extension elements as extra tests.
    stack.push(frame);
  };
  const text = (value: string): void => {
    const detail = stack.findLast((frame) => frame.detail)?.detail;
    if (detail) detail.text += value;
  };
  parser.ontext = text;
  parser.oncdata = text;
  parser.onclosetag = () => {
    const frame = stack.pop();
    if (!frame) throw new Error('Invalid JUnit nesting.');
    if (frame.test) {
      if (
        (frame.attrs.status === 'passed' && frame.test.outcome !== 'passed') ||
        (frame.attrs.failure &&
          !frame.test.details.some((d) => d.kind === 'failure'))
      )
        throw new Error('Contradictory JUnit testcase status and outcome.');
      cases.push(frame.test);
    }
    if (['testsuite', 'testsuites'].includes(frame.tag)) {
      const subset = cases.slice(frame.start);
      for (const [key, actual] of [
        ['tests', subset.length],
        ['failures', subset.filter((c) => c.outcome === 'failed').length],
        ['errors', subset.filter((c) => c.outcome === 'error').length],
        ['skipped', subset.filter((c) => c.outcome === 'skipped').length],
      ] as const) {
        const declared = numeric(frame.attrs[key], key, true);
        if (declared !== null && declared !== actual)
          throw new Error(
            `JUnit ${key} count contradicts testcase records (${declared} vs ${actual}).`,
          );
      }
    }
  };
  // Bound parser token buffers and avoid a single enormous text token allocation.
  for (let offset = 0; offset < xml.length; offset += 4096)
    parser.write(xml.slice(offset, offset + 4096));
  parser.close();
  if (roots !== 1) throw new Error('JUnit XML is empty or missing its root.');
  return { cases, problems: [...problems] };
}

async function normalDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('JUnit evidence path is not a normal directory.');
}

export async function createEvidenceDirectory(root: string, runId: string) {
  let directory = root;
  for (const segment of ['.donegauge', 'evidence', runId]) {
    directory = resolve(directory, segment);
    await mkdir(directory, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
    await normalDirectory(directory);
  }
  directory = resolve(directory, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  // Keep the original directory open until collection finishes. In particular,
  // Linux may recycle a deleted directory's inode immediately if only its stat
  // was retained, making a newly created replacement look like the original.
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const identity = await handle.stat();
    return { directory, identity, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readJunitEvidence(
  root: string,
  evidence: Awaited<ReturnType<typeof createEvidenceDirectory>>,
  file: string,
): Promise<{ path: string; bytes: number; sha256: string; data: Buffer }> {
  const target = resolve(file.replaceAll('{evidenceDir}', evidence.directory));
  if (target === evidence.directory || !isWithin(evidence.directory, target))
    throw new Error(
      'JUnit report must stay inside this execution evidence directory.',
    );
  let current = root;
  const segments = relative(root, target).split(sep);
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    await normalDirectory(current);
  }
  const identity = await lstat(evidence.directory);
  const original = await evidence.handle.stat();
  if (
    original.nlink === 0 ||
    identity.dev !== evidence.identity.dev ||
    identity.ino !== evidence.identity.ino
  )
    throw new Error('JUnit evidence directory was replaced during execution.');
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new Error(
        'JUnit report must be a normal file, without symlinks or hard links.',
      );
    if (before.size > JUNIT_LIMITS.bytes)
      throw new Error('JUnit XML exceeds 10 MiB.');
    const data = Buffer.alloc(
      Math.min(before.size + 1, JUNIT_LIMITS.bytes + 1),
    );
    let length = 0;
    while (length < data.length) {
      const read = await handle.read(data, length, data.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('JUnit report changed while being read.');
    const bytes = data.subarray(0, length);
    return {
      path: relative(root, target),
      bytes: length,
      sha256: sha256(bytes),
      data: bytes,
    };
  } finally {
    await handle.close();
  }
}
