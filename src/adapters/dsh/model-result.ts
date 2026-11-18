import { terminalSafe } from '../../reporters/index.js';
import type { AcceptanceStatus } from '../../core/types.js';
import { byReviewPriority, statuses } from './card-data.js';

const visibleCriteriaLimit = 8;
const reasonLimit = 112;

interface ModelResult {
  finalStatus: 'VERIFIED' | 'REVIEW REQUIRED';
  summary: Record<AcceptanceStatus, number>;
  criteria: readonly {
    id: string;
    status: AcceptanceStatus;
    evidenceId: string;
    reason: string;
  }[];
  reports: { markdown: string; json: string };
  warnings: readonly string[];
}

function oneLine(value: string): string {
  const line = terminalSafe(value).replace(/\s+/gu, ' ').trim();
  return line.length > reasonLimit
    ? `${line
        .slice(0, reasonLimit - 1)
        .replace(/[\uD800-\uDBFF]$/u, '')
        .trimEnd()}…`
    : line;
}

export function renderModelResult(result: ModelResult): string {
  const criteria =
    result.criteria.length <= visibleCriteriaLimit
      ? result.criteria
      : byReviewPriority(result.criteria).slice(0, visibleCriteriaLimit);
  const counts = statuses
    .map((status) => `${status} ${result.summary[status]}`)
    .join(' / ');
  const lines = [`${result.finalStatus} · ${counts}`];
  for (const criterion of criteria) {
    const reason =
      criterion.status === 'PASS' ? '' : ` · ${oneLine(criterion.reason)}`;
    const evidence = criterion.evidenceId
      ? ` · Evidence ID: ${criterion.evidenceId}`
      : ' · No execution evidence';
    lines.push(`[${criterion.status}] ${criterion.id}${reason}${evidence}`);
  }
  if (criteria.length < result.criteria.length)
    lines.push(
      `Showing ${criteria.length}/${result.criteria.length} criteria. See the reports for all results.`,
    );
  for (const warning of result.warnings)
    lines.push(`Warning: ${oneLine(warning)}`);
  lines.push(
    `Markdown: ${result.reports.markdown}`,
    `JSON: ${result.reports.json}`,
  );
  return lines.join('\n');
}
