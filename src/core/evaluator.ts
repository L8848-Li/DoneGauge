import type {
  AcceptanceStatus,
  CommandCheck,
  ExecutionEvidence,
} from './types.js';

export function evaluate(
  check: CommandCheck,
  evidence: ExecutionEvidence,
): { status: AcceptanceStatus; reason: string } {
  if (evidence.state !== 'exited' || evidence.exitCode === null) {
    return {
      status: 'ERROR',
      reason:
        evidence.error ??
        'Check did not complete normally. No functional failure has been established.',
    };
  }
  const expectedExit = check.expect?.exitCode ?? 0;
  if (evidence.exitCode !== expectedExit) {
    return {
      status: 'FAIL',
      reason: `Check exited ${evidence.exitCode}; expected ${expectedExit}.`,
    };
  }
  let incomplete: 'stdout' | 'stderr' | undefined;
  for (const stream of ['stdout', 'stderr'] as const) {
    const expected = check.expect?.[`${stream}Includes`];
    if (expected !== undefined && !evidence[stream].includes(expected)) {
      if (evidence[`${stream}Truncated`] ?? evidence.outputTruncated) {
        incomplete ??= stream;
        continue;
      }
      return {
        status: 'FAIL',
        reason: `Check completed, but ${stream} did not contain the configured expected text.`,
      };
    }
  }
  if (incomplete)
    return {
      status: 'UNVERIFIED',
      reason: `Expected ${incomplete} text is absent from the retained log, but output was truncated. Increase maxOutputBytes or reduce check output.`,
    };
  return {
    status: 'PASS',
    reason: `Configured check completed with expected exit code ${expectedExit}${check.expect?.stdoutIncludes || check.expect?.stderrIncludes ? ' and expected output' : ''}.`,
  };
}
