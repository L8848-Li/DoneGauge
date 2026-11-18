export type AcceptanceStatus = 'PASS' | 'FAIL' | 'UNVERIFIED' | 'ERROR';

export interface CommandCheck {
  kind?: 'command';
  command: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  expect?: {
    exitCode?: number;
    stdoutIncludes?: string;
    stderrIncludes?: string;
  };
}

export interface TestSelector {
  name: string;
  className?: string;
}

export interface JunitCheck extends Omit<CommandCheck, 'kind' | 'expect'> {
  kind: 'junit';
  expect?: never;
  junit: { file: string; tests: TestSelector[]; minExecuted?: number };
}

export type Check = CommandCheck | JunitCheck;

export interface TestCaseEvidence {
  name: string;
  className: string | null;
  suite: string[];
  file: string | null;
  line: number | null;
  durationMs: number | null;
  outcome: 'passed' | 'failed' | 'error' | 'skipped' | 'unverified';
  details: {
    kind: string;
    type: string | null;
    message: string;
    text: string;
  }[];
  reportLine: number;
}

export interface TestEvidence {
  parserVersion: 'donegauge-junit-1';
  runId: string;
  executionId: string;
  configSha256: string;
  git: {
    baseCommit: string | null;
    headCommit: string | null;
    fingerprint: string;
  };
  source: { path: string; sha256: string | null; bytes: number | null };
  cases: TestCaseEvidence[];
  selections: { selector: TestSelector; matches: number[] }[];
  counts: {
    total: number;
    executed: number;
    targets: number;
    matched: number;
    executedTargets: number;
  };
  problems: string[];
  error: string | null;
}

export interface Criterion {
  id: string;
  description: string;
  check?: Check;
}

export interface AcceptanceConfig {
  $schema?: string;
  version: 1;
  task: string;
  base?: string;
  criteria: Criterion[];
}

export interface ChangedFile {
  path: string;
  status:
    'added' | 'modified' | 'deleted' | 'type-changed' | 'unmerged' | 'unknown';
  untracked: boolean;
}

export interface GitChanges {
  base: string;
  baseCommit: string | null;
  headCommit: string | null;
  files: ChangedFile[];
  summary: string;
  diff: string;
  diffTruncated: boolean;
  fingerprint: string;
}

export interface ExecutionEvidence {
  id: string;
  command: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  state: 'exited' | 'spawn-error' | 'timed-out' | 'signaled' | 'aborted';
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  stdoutSha256: string;
  stderrSha256: string;
  error: string | null;
}

export interface CriterionResult {
  id: string;
  description: string;
  check: Check | null;
  status: AcceptanceStatus;
  reason: string;
  evidence: ExecutionEvidence | null;
  testEvidence?: TestEvidence;
}

export interface AcceptanceReport {
  reportVersion: 1;
  toolVersion: string;
  runId: string;
  task: string;
  config: { path: string; sha256: string };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  changes: GitChanges;
  workspaceChangedDuringRun: boolean;
  warnings: string[];
  criteria: CriterionResult[];
  summary: Record<AcceptanceStatus, number>;
  finalStatus: 'VERIFIED' | 'REVIEW REQUIRED';
}
