import { mkdir, realpath, writeFile, lstat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { isWithin } from '../core/config.js';
import { DoneGaugeError } from '../core/errors.js';
import type { AcceptanceReport } from '../core/types.js';

// Remove terminal control sequences, including OSC hyperlinks, without altering JSON evidence.
export function terminalSafe(text: string): string {
  return stripVTControlCharacters(text).replace(/\p{Cc}/gu, (char) =>
    char === '\n' || char === '\t' ? char : '',
  );
}

export function renderTerminal(report: AcceptanceReport): string {
  const lines = [
    'DoneGauge — Acceptance Report',
    '',
    `Task: ${report.task}`,
    `Run: ${report.runId}`,
    `Started: ${report.startedAt}`,
    `Duration: ${report.durationMs} ms`,
    `Config SHA-256: ${report.config.sha256}`,
    `Git base: ${report.changes.base} (${report.changes.baseCommit ?? 'empty tree'})`,
    `Changed files: ${report.changes.files.length}`,
    report.changes.summary,
    ...report.changes.files.map(
      (file) =>
        `  ${file.status.padEnd(12)} ${file.path}${file.untracked ? ' (untracked)' : ''}`,
    ),
    '',
    'Acceptance criteria:',
    '',
  ];
  for (const result of report.criteria) {
    lines.push(
      `[${result.status}] ${result.id}: ${result.description}`,
      `  ${result.reason}`,
    );
    if (result.evidence) {
      const e = result.evidence;
      lines.push(
        `  Evidence: ${e.id}`,
        `  Command: ${JSON.stringify(e.command)} (cwd: ${e.cwd})`,
        `  Execution: ${e.state}; exit: ${e.exitCode ?? 'none'}; ${e.durationMs} ms${e.outputTruncated ? '; OUTPUT TRUNCATED' : ''}`,
      );
      const log = (e.stderr || e.stdout).trim();
      if (result.status !== 'PASS' && log)
        lines.push(`  Log excerpt: ${log.slice(0, 1000)}`);
    }
    if (result.testEvidence) {
      const tests = result.testEvidence;
      lines.push(
        `  JUnit: ${tests.counts.executedTargets}/${tests.counts.targets} target tests executed; ${tests.counts.total} total cases`,
        `  XML: ${tests.source.path}; SHA-256: ${tests.source.sha256 ?? 'unavailable'}`,
      );
      for (const selection of tests.selections) {
        const item =
          selection.matches.length === 1
            ? tests.cases[selection.matches[0]!]
            : undefined;
        lines.push(
          `    ${selection.selector.name}${selection.selector.className ? ` (${selection.selector.className})` : ''}: ${item?.outcome ?? (selection.matches.length ? 'ambiguous' : 'missing')}`,
        );
        for (const detail of item?.details ?? [])
          lines.push(`      ${detail.message} ${detail.text}`.slice(0, 1000));
      }
      for (const problem of tests.problems)
        lines.push(`    Review: ${problem}`);
    }
    lines.push('');
  }
  lines.push(
    `Summary: ${report.summary.PASS} verified, ${report.summary.FAIL} failed, ${report.summary.UNVERIFIED} unverified, ${report.summary.ERROR} errors`,
  );
  for (const warning of report.warnings) lines.push(`Notice: ${warning}`);
  lines.push(
    `Final status: ${report.finalStatus}`,
    'PASS means the configured check met its contract; it does not prove all behavior is correct.',
  );
  return terminalSafe(lines.join('\n')) + '\n';
}

function md(text: string): string {
  return terminalSafe(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}|#!]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
}

function code(text: string, language = ''): string {
  // A log may itself contain Markdown fences or HTML; keep it inside its fence.
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(
    runs.reduce((length, run) => Math.max(length, run.length + 1), 3),
  );
  return `${fence}${language}\n${terminalSafe(text)}\n${fence}`;
}

export function renderMarkdown(report: AcceptanceReport): string {
  const lines = [
    '# DoneGauge — Acceptance Report',
    '',
    `**Task:** ${md(report.task)}`,
    '',
    `**Run:** ${report.runId}  `,
    `**Started:** ${report.startedAt}  `,
    `**Finished:** ${report.finishedAt}  `,
    `**Duration:** ${report.durationMs} ms  `,
    `**Configuration:** ${md(report.config.path)}  `,
    `**Config SHA-256:** ${report.config.sha256}`,
    '',
    '## Git changes',
    '',
    `Base: ${md(report.changes.base)} (${report.changes.baseCommit ?? 'empty tree'})`,
    '',
    md(report.changes.summary),
    '',
    '| Status | File | Source |',
    '| --- | --- | --- |',
    ...report.changes.files.map(
      (file) =>
        `| ${file.status} | ${md(file.path)} | ${file.untracked ? 'untracked' : 'tracked'} |`,
    ),
    '',
    '## Acceptance criteria',
    '',
  ];
  for (const result of report.criteria) {
    lines.push(
      `### [${result.status}] ${md(result.id)}: ${md(result.description)}`,
      '',
      md(result.reason),
      '',
    );
    const e = result.evidence;
    if (!e) {
      lines.push('No execution evidence.', '');
      continue;
    }
    lines.push(
      `Evidence ID: ${e.id}  `,
      `Working directory: ${md(e.cwd)}  `,
      `State: ${e.state}; exit code: ${e.exitCode ?? 'none'}; signal: ${e.signal ?? 'none'}  `,
      `Started: ${e.startedAt}; finished: ${e.finishedAt}; duration: ${e.durationMs} ms  `,
      `Output: stdout ${e.stdoutBytes} bytes, stderr ${e.stderrBytes} bytes${e.outputTruncated ? ' (TRUNCATED)' : ''}`,
      '',
      code(JSON.stringify(e.command), 'json'),
      '',
      '**Configured contract**',
      '',
      code(
        JSON.stringify(
          result.check?.kind === 'junit'
            ? result.check.junit
            : (result.check?.expect ?? { exitCode: 0 }),
        ),
        'json',
      ),
      '',
      '**stdout**',
      '',
      code(e.stdout, 'text'),
      '',
      '**stderr**',
      '',
      code(e.stderr, 'text'),
      '',
    );
    if (e.error) lines.push(`Execution error: ${md(e.error)}`, '');
    if (result.testEvidence) {
      const tests = result.testEvidence;
      lines.push(
        '**JUnit target tests**',
        '',
        `Target tests executed: ${tests.counts.executedTargets}/${tests.counts.targets}; total cases: ${tests.counts.total}.`,
        '',
        `Raw XML: ${md(tests.source.path)}  `,
        `SHA-256: ${tests.source.sha256 ?? 'unavailable'}  `,
        `Execution ID: ${tests.executionId}`,
        '',
        '| Target | Class | Matches | Outcome | Test location |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const selection of tests.selections) {
        const item =
          selection.matches.length === 1
            ? tests.cases[selection.matches[0]!]
            : undefined;
        lines.push(
          `| ${md(selection.selector.name)} | ${md(selection.selector.className ?? '')} | ${selection.matches.length} | ${item?.outcome ?? (selection.matches.length ? 'ambiguous' : 'missing')} | ${md(item?.file ?? '')}${item?.line !== null && item?.line !== undefined ? `:${item.line}` : ''} |`,
        );
      }
      lines.push(
        '',
        'Locations identify test files; failure text is not a verified product root cause.',
        '',
      );
      for (const item of tests.cases.filter((c) => c.details.length)) {
        lines.push(
          `Test: ${md(item.name)} (XML line ${item.reportLine})`,
          '',
          code(
            item.details
              .map((d) => `${d.kind}: ${d.type ?? ''} ${d.message}\n${d.text}`)
              .join('\n'),
            'text',
          ),
          '',
        );
      }
      for (const problem of tests.problems) lines.push(md(problem), '');
    }
  }
  lines.push(
    '## Summary',
    '',
    `${report.summary.PASS} verified; ${report.summary.FAIL} failed; ${report.summary.UNVERIFIED} unverified; ${report.summary.ERROR} errors.`,
    '',
    `**Final status: ${report.finalStatus}**`,
    '',
    ...report.warnings.map((w) => `- ${md(w)}`),
    '',
    'PASS means the configured check met its contract. Test quality and coverage require human review.',
    '',
    '## Diff evidence',
    '',
    `Snapshot fingerprint: ${report.changes.fingerprint}`,
    '',
    report.changes.diffTruncated
      ? 'Diff truncated at 256 KiB.'
      : 'Tracked and untracked changes relative to the selected base.',
    '',
    code(report.changes.diff, 'diff'),
    '',
  );
  return lines.join('\n');
}

export function renderJson(report: AcceptanceReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}

export async function writeReports(
  root: string,
  report: AcceptanceReport,
  outputDir = '.donegauge',
): Promise<{ json: string; markdown: string }> {
  const target = resolve(root, outputDir, 'runs', report.runId);
  if (!isWithin(root, target))
    throw new DoneGaugeError(
      'Report directory must be inside the project. Choose a relative --output-dir.',
      'IO',
    );
  // Inspect each existing parent before creating directories: never follow a
  // report directory symlink into another project or overwrite an existing run.
  let current = await realpath(root);
  for (const segment of relative(root, target).split(sep)) {
    current = resolve(current, segment);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && (info.isSymbolicLink() || !info.isDirectory()))
      throw new DoneGaugeError(
        `Report path is not a normal directory: ${relative(root, current)}. Choose another --output-dir.`,
        'IO',
      );
    if (!info) await mkdir(current, { mode: 0o700 });
    else if (current === target)
      throw new DoneGaugeError(
        'This run directory already exists; refusing to overwrite evidence.',
        'IO',
      );
  }
  const json = resolve(target, 'report.json');
  const markdown = resolve(target, 'report.md');
  await writeFile(json, renderJson(report), { flag: 'wx', mode: 0o600 });
  await writeFile(markdown, renderMarkdown(report), {
    flag: 'wx',
    mode: 0o600,
  });
  return { json: relative(root, json), markdown: relative(root, markdown) };
}
