import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig, projectPath, sha256 } from './config.js';
import { DoneGaugeError, errorMessage } from './errors.js';
import { evaluate } from './evaluator.js';
import { collectChanges, repositoryRoot } from './git.js';
import { runCommand } from './runner.js';
import {
  createEvidenceDirectory,
  expandEvidenceDirectory,
  parseJunit,
  readJunitEvidence,
} from './junit.js';
import { evaluateJunit, selectJunitTests } from './junit-evaluator.js';
import { version } from './version.js';
import type {
  AcceptanceReport,
  CriterionResult,
  TestEvidence,
} from './types.js';

export interface CheckOptions {
  cwd?: string;
  configPath?: string;
  base?: string;
  execute?: boolean;
  approvedConfigSha256?: string;
  signal?: AbortSignal;
}

export async function checkAcceptance(
  options: CheckOptions = {},
): Promise<AcceptanceReport> {
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const root = await repositoryRoot(
    resolve(options.cwd ?? process.cwd()),
    options.signal,
  );
  const loaded = await loadConfig(root, options.configPath ?? 'donegauge.json');
  if (
    options.approvedConfigSha256 !== undefined &&
    loaded.sha256 !== options.approvedConfigSha256
  ) {
    throw new DoneGaugeError(
      'Acceptance configuration differs from the approved SHA-256. Review it and update the DSH overlay approval before running commands.',
      'TRUST',
    );
  }
  // Resolve every command directory before starting any command.
  const directories = await Promise.all(
    loaded.config.criteria.map(async ({ check }) => {
      if (!check) return null;
      const directory = await projectPath(root, check.cwd ?? '.', 'Check cwd');
      if (!(await stat(directory)).isDirectory())
        throw new DoneGaugeError(
          'check.cwd must be a directory inside the project.',
          'CONFIG',
        );
      return directory;
    }),
  );
  const base = options.base ?? loaded.config.base ?? 'HEAD';
  const changes = await collectChanges(root, base, options.signal);
  const criteria: CriterionResult[] = [];
  for (const [index, criterion] of loaded.config.criteria.entries()) {
    options.signal?.throwIfAborted();
    const check = criterion.check;
    const cwd = directories[index];
    if (!check || !cwd || !options.execute) {
      criteria.push({
        id: criterion.id,
        description: criterion.description,
        check: check ?? null,
        status: 'UNVERIFIED',
        evidence: null,
        reason: !check
          ? 'No verification command configured. Add a check to collect evidence.'
          : 'Preview only. Review the configured command, then run check --allow-run to execute it.',
      });
      continue;
    }
    const junitDirectory =
      check.kind === 'junit'
        ? await createEvidenceDirectory(root, runId)
        : null;
    try {
      const command = junitDirectory
        ? check.command.map((arg) =>
            expandEvidenceDirectory(arg, junitDirectory.directory),
          )
        : check.command;
      const evidence = await runCommand(command, cwd, {
        displayCwd: relative(root, cwd) || '.',
        ...(check.timeoutMs !== undefined
          ? { timeoutMs: check.timeoutMs }
          : {}),
        ...(check.maxOutputBytes !== undefined
          ? { maxOutputBytes: check.maxOutputBytes }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.signal?.throwIfAborted();
      let testEvidence: TestEvidence | undefined;
      if (check.kind === 'junit' && junitDirectory) {
        testEvidence = {
          parserVersion: 'donegauge-junit-1',
          runId,
          executionId: evidence.id,
          configSha256: loaded.sha256,
          git: {
            baseCommit: changes.baseCommit,
            headCommit: changes.headCommit,
            fingerprint: changes.fingerprint,
          },
          source: {
            path: relative(
              root,
              expandEvidenceDirectory(
                check.junit.file,
                junitDirectory.directory,
              ),
            )
              .split(sep)
              .join('/'),
            sha256: null,
            bytes: null,
          },
          cases: [],
          selections: check.junit.tests.map((selector) => ({
            selector,
            matches: [],
          })),
          counts: {
            total: 0,
            executed: 0,
            targets: check.junit.tests.length,
            matched: 0,
            executedTargets: 0,
          },
          problems: [],
          error: null,
        };
        try {
          const source = await readJunitEvidence(
            root,
            junitDirectory,
            check.junit.file,
          );
          testEvidence.source = {
            path: source.path,
            sha256: source.sha256,
            bytes: source.bytes,
          };
          const parsed = parseJunit(
            new TextDecoder('utf-8', { fatal: true }).decode(source.data),
          );
          testEvidence.cases = parsed.cases;
          testEvidence.problems = parsed.problems;
          const selection = selectJunitTests(parsed.cases, check.junit.tests);
          testEvidence.selections = selection.selections;
          testEvidence.counts = selection.counts;
        } catch (error) {
          testEvidence.error = `Cannot collect complete JUnit evidence: ${errorMessage(error)}`;
        }
      }
      criteria.push({
        id: criterion.id,
        description: criterion.description,
        check,
        evidence,
        ...(testEvidence ? { testEvidence } : {}),
        ...(check.kind === 'junit'
          ? evaluateJunit(check, evidence, testEvidence!)
          : evaluate(check, evidence)),
      });
    } finally {
      await junitDirectory?.handle.close();
    }
  }
  const after = await collectChanges(root, base, options.signal);
  const configAfter = await readFile(resolve(root, loaded.path)).catch(
    () => null,
  );
  const workspaceChangedDuringRun =
    changes.fingerprint !== after.fingerprint ||
    !configAfter ||
    sha256(configAfter) !== loaded.sha256;
  const warnings: string[] = [];
  if (workspaceChangedDuringRun)
    warnings.push(
      'Project or configuration changed during verification. Review generated changes and rerun against a stable working tree.',
    );
  if (changes.diffTruncated)
    warnings.push(
      'Git diff was truncated to 256 KiB. The file list and snapshot fingerprint were collected separately.',
    );
  if (criteria.some(({ evidence }) => evidence?.outputTruncated))
    warnings.push(
      'Some command output was truncated. Retained logs and original byte counts are included in each evidence record.',
    );
  if (
    changes.files.some(
      ({ status }) => status === 'unmerged' || status === 'unknown',
    )
  )
    warnings.push(
      'The working tree contains unresolved or unsupported file states. Review the Git changes.',
    );
  const summary = { PASS: 0, FAIL: 0, UNVERIFIED: 0, ERROR: 0 };
  for (const criterion of criteria) summary[criterion.status]++;
  return {
    reportVersion: 1,
    toolVersion: version,
    runId,
    task: loaded.config.task,
    config: { path: loaded.path, sha256: loaded.sha256 },
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    changes,
    workspaceChangedDuringRun: Boolean(workspaceChangedDuringRun),
    warnings,
    criteria,
    summary,
    finalStatus:
      criteria.length > 0 &&
      summary.PASS === criteria.length &&
      !workspaceChangedDuringRun &&
      !changes.files.some(
        (file) => file.status === 'unmerged' || file.status === 'unknown',
      )
        ? 'VERIFIED'
        : 'REVIEW REQUIRED',
  };
}
