export type AcceptanceStatus = 'PASS' | 'FAIL' | 'UNVERIFIED' | 'ERROR';

export interface Check {
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
}

export interface AcceptanceReport {
  reportVersion: 1;
  toolVersion: '0.1.0';
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
