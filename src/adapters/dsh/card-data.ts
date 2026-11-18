export const cardKind = 'donegauge.acceptance.v1';
export const statuses = ['PASS', 'FAIL', 'UNVERIFIED', 'ERROR'] as const;
type Status = (typeof statuses)[number];

interface CardCriterion {
  id: string;
  status: Status;
  reason: string;
  evidenceId: string;
  execution: string;
  targetTests: number;
  executedTargetTests: number;
  testEvidencePath: string;
  targetTestResults: { name: string; className: string; outcome: string }[];
}

interface CardData {
  kind: typeof cardKind;
  runId: string;
  task: string;
  finalStatus: 'VERIFIED' | 'REVIEW REQUIRED';
  summary: Record<Status, number>;
  criteria: CardCriterion[];
  reports: { markdown: string; json: string };
  warnings: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === 'string';

function isCriterion(value: unknown): value is CardCriterion {
  return (
    isRecord(value) &&
    isText(value.id) &&
    statuses.includes(value.status as Status) &&
    [
      value.reason,
      value.evidenceId,
      value.execution,
      value.testEvidencePath,
    ].every(isText) &&
    isCount(value.targetTests) &&
    isCount(value.executedTargetTests) &&
    value.executedTargetTests <= value.targetTests &&
    Array.isArray(value.targetTestResults) &&
    value.targetTestResults.every(
      (item: unknown) =>
        isRecord(item) &&
        [item.name, item.className, item.outcome].every(isText),
    )
  );
}

export function readCardData(value: unknown): CardData | undefined {
  if (
    !isRecord(value) ||
    value.kind !== cardKind ||
    typeof value.runId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.runId) ||
    !isText(value.task) ||
    !['VERIFIED', 'REVIEW REQUIRED'].includes(value.finalStatus as string) ||
    !Array.isArray(value.criteria) ||
    value.criteria.length > 100 ||
    !value.criteria.every(isCriterion) ||
    !isRecord(value.summary) ||
    !isRecord(value.reports) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(isText)
  )
    return undefined;

  const { criteria, summary, reports, runId } = value;
  if (
    !statuses.every(
      (status) =>
        summary[status] ===
        criteria.filter((item) => item.status === status).length,
    )
  )
    return undefined;
  const reportDirectory = `.donegauge/runs/${runId}`;
  if (
    !isText(reports.markdown) ||
    reports.markdown.replaceAll('\\', '/') !== `${reportDirectory}/report.md` ||
    !isText(reports.json) ||
    reports.json.replaceAll('\\', '/') !== `${reportDirectory}/report.json`
  )
    return undefined;
  return value as unknown as CardData;
}

export function isEvidencePath(path: string, runId: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return (
    normalized.startsWith(`.donegauge/evidence/${runId}/`) &&
    normalized
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..') &&
    !normalized.includes(':') &&
    !normalized.includes('\0')
  );
}
