import type { InferValue } from '@deepseek-ai/dsh-tools';
import type { AcceptanceReport } from '../../core/types.js';
import { cardKind } from './card-data.js';
import { renderModelResult } from './model-result.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string', required: true },
    task: { type: 'string', required: true },
    finalStatus: {
      type: 'string',
      enum: ['VERIFIED', 'REVIEW REQUIRED'],
      required: true,
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        PASS: { type: 'integer', required: true },
        FAIL: { type: 'integer', required: true },
        UNVERIFIED: { type: 'integer', required: true },
        ERROR: { type: 'integer', required: true },
      },
    },
    criteria: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: {
            type: 'string',
            enum: ['PASS', 'FAIL', 'UNVERIFIED', 'ERROR'],
            required: true,
          },
          reason: { type: 'string', required: true },
          evidenceId: { type: 'string', required: true },
          execution: { type: 'string', required: true },
          targetTests: { type: 'integer', required: true },
          executedTargetTests: { type: 'integer', required: true },
          testEvidencePath: { type: 'string', required: true },
          testEvidenceAvailable: { type: 'boolean', required: true },
          targetTestResults: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                className: { type: 'string', required: true },
                matches: { type: 'integer', required: true },
                outcome: { type: 'string', required: true },
              },
            },
          },
        },
      },
    },
    reports: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        json: { type: 'string', required: true },
        markdown: { type: 'string', required: true },
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      required: true,
    },
    text: { type: 'string', required: true },
  },
} as const;
type ReportValue = InferValue<typeof schema>;
export const reportOutput = {
  schema,
  render: (_args: unknown, value: ReportValue) => [
    { type: 'text' as const, text: value.text },
  ],
  presentationMeta: (
    _args: unknown,
    {
      runId,
      task,
      finalStatus,
      summary,
      criteria,
      reports,
      warnings,
    }: ReportValue,
  ) => ({
    kind: cardKind,
    runId,
    task,
    finalStatus,
    summary,
    criteria,
    reports,
    warnings,
  }),
};
export function reportResult(
  report: AcceptanceReport,
  reports: { markdown: string; json: string },
) {
  const result = {
    runId: report.runId,
    task: report.task,
    finalStatus: report.finalStatus,
    summary: report.summary,
    criteria: report.criteria.map((c) => ({
      id: c.id,
      status: c.status,
      reason: c.reason,
      evidenceId: c.evidence?.id ?? '',
      execution: c.evidence
        ? [
            c.evidence.state,
            c.evidence.exitCode === null ? null : `exit ${c.evidence.exitCode}`,
            c.evidence.signal,
          ]
            .filter(Boolean)
            .join(' · ')
        : '',
      targetTests: c.testEvidence?.counts.targets ?? 0,
      executedTargetTests: c.testEvidence?.counts.executedTargets ?? 0,
      testEvidencePath: c.testEvidence?.source.path ?? '',
      testEvidenceAvailable: c.testEvidence?.source.bytes != null,
      targetTestResults:
        c.testEvidence?.selections.map((s) => ({
          name: s.selector.name,
          className: s.selector.className ?? '',
          matches: s.matches.length,
          outcome:
            s.matches.length === 1
              ? c.testEvidence!.cases[s.matches[0]!]!.outcome
              : s.matches.length
                ? 'ambiguous'
                : 'missing',
        })) ?? [],
    })),
    reports,
    warnings: report.warnings,
  };
  return { ...result, text: renderModelResult(result) };
}
