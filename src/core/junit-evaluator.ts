import type {
  AcceptanceStatus,
  ExecutionEvidence,
  JunitCheck,
  TestCaseEvidence,
  TestEvidence,
  TestSelector,
} from './types.js';

function executed(test: TestCaseEvidence): boolean {
  return (
    test.outcome === 'passed' ||
    test.outcome === 'failed' ||
    test.outcome === 'error'
  );
}

export function selectJunitTests(
  cases: TestCaseEvidence[],
  selectors: TestSelector[],
): Pick<TestEvidence, 'selections' | 'counts'> {
  const byName = new Map<string, Map<string | undefined, number[]>>();
  const selections = selectors.map((selector) => {
    const byClass =
      byName.get(selector.name) ?? new Map<string | undefined, number[]>();
    byName.set(selector.name, byClass);
    const matches = byClass.get(selector.className) ?? [];
    byClass.set(selector.className, matches);
    return { selector, matches };
  });
  let executedCases = 0;
  for (const [index, item] of cases.entries()) {
    if (executed(item)) executedCases++;
    const byClass = byName.get(item.name);
    byClass?.get(undefined)?.push(index);
    if (item.className !== null) byClass?.get(item.className)?.push(index);
  }
  let matched = 0;
  const executedTargets = new Set<number>();
  for (const { matches } of selections) {
    if (matches.length !== 1) continue;
    matched++;
    const index = matches[0]!;
    if (executed(cases[index]!)) executedTargets.add(index);
  }
  return {
    selections,
    counts: {
      total: cases.length,
      executed: executedCases,
      targets: selectors.length,
      matched,
      executedTargets: executedTargets.size,
    },
  };
}

export function evaluateJunit(
  check: JunitCheck,
  execution: ExecutionEvidence,
  tests: TestEvidence,
): { status: AcceptanceStatus; reason: string } {
  if (execution.state !== 'exited' || execution.exitCode === null)
    return {
      status: 'ERROR',
      reason: execution.error ?? 'JUnit command did not complete normally.',
    };
  if (tests.error) return { status: 'ERROR', reason: tests.error };
  const selected = tests.selections.flatMap((s) =>
    s.matches.length === 1 ? [tests.cases[s.matches[0]!]!] : [],
  );
  if (tests.cases.some((c) => c.outcome === 'error'))
    return {
      status: 'ERROR',
      reason:
        'JUnit reports a test execution/setup/teardown error. Inspect test and process evidence.',
    };
  if (selected.some((c) => c.outcome === 'failed'))
    return {
      status: 'FAIL',
      reason: 'A uniquely selected target test reports an assertion failure.',
    };
  if (
    tests.problems.length ||
    tests.selections.some((s) => s.matches.length !== 1) ||
    selected.some((c) => ['skipped', 'unverified'].includes(c.outcome)) ||
    tests.counts.executedTargets < (check.junit.minExecuted ?? 1)
  )
    return {
      status: 'UNVERIFIED',
      reason:
        'Target tests are missing, ambiguous, skipped, file wrappers, below minExecuted, or contain unsupported evidence. Review the target test records.',
    };
  if (execution.exitCode !== 0)
    return {
      status: 'ERROR',
      reason: `JUnit command exited ${execution.exitCode}; target results alone cannot establish a complete successful run.`,
    };
  if (tests.cases.some((c) => c.outcome === 'failed'))
    return {
      status: 'ERROR',
      reason:
        'JUnit contains unrelated failures despite command exit 0. Review conflicting evidence.',
    };
  return {
    status: 'PASS',
    reason: `All ${tests.counts.executedTargets} selected target tests executed and passed; command exited 0 with complete JUnit evidence.`,
  };
}
