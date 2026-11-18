import { isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools';
import { checkAcceptance } from '../../core/check.js';
import { errorMessage } from '../../core/errors.js';
import { repositoryRoot } from '../../core/git.js';
import { writeReports } from '../../reporters/index.js';
import { cardKind } from './card-data.js';

export const name = 'donegauge';
export const inject = ['tools'];

export interface DshConfig {
  root?: string;
  configPath?: string;
  approvedConfigSha256?: string;
}

export function apply(ctx: Context, config: DshConfig = {}): void {
  // Deployment config is human-authored, never supplied as model arguments.
  for (const key of Object.keys(config)) {
    if (!['root', 'configPath', 'approvedConfigSha256'].includes(key))
      throw new Error(`Unknown DoneGauge plugin configuration field: ${key}`);
  }
  if (
    config.root !== undefined &&
    (typeof config.root !== 'string' || !isAbsolute(config.root))
  )
    throw new Error(
      'DoneGauge root must be an absolute path to the project Git root.',
    );
  if (config.configPath !== undefined && typeof config.configPath !== 'string')
    throw new Error('DoneGauge configPath must be a project-relative path.');
  if (
    config.approvedConfigSha256 !== undefined &&
    (typeof config.approvedConfigSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(config.approvedConfigSha256))
  )
    throw new Error(
      'DoneGauge approvedConfigSha256 must be the digest printed by donegauge config-hash.',
    );
  const approved = { ...config };
  let running = false;
  ctx.tools.register(
    defineTool({
      name: 'donegauge_check',
      description:
        'Run the human-approved DoneGauge acceptance configuration for the bound project. Use when the user requests acceptance verification. Returns statuses and local evidence paths. Accepts no commands or paths.',
      parameters: {},
      output: {
        schema: {
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
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `${value.text}\nReports: ${value.reports.markdown}\n         ${value.reports.json}`,
          },
        ],
        presentationMeta: (
          _args,
          { runId, task, finalStatus, summary, criteria, reports, warnings },
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
      },
      async execute(args, exec) {
        if (Object.keys(args).length)
          throw new ToolArgsError([
            'donegauge_check accepts no arguments. Configure the project and commands in the human-owned DSH patch and donegauge.json.',
          ]);
        if (!approved.root || !approved.approvedConfigSha256)
          throw new ToolArgsError([
            'DoneGauge is not configured. Set root and approvedConfigSha256 in a local DSH --patch overlay. See docs/dsh.md.',
          ]);
        if (running)
          throw new ToolArgsError([
            'A DoneGauge check is already running. Wait for it to finish.',
          ]);
        exec.signal.throwIfAborted();
        running = true;
        try {
          const root = await repositoryRoot(approved.root, exec.signal);
          if (root !== (await realpath(approved.root)))
            throw new ToolArgsError([
              'DoneGauge root must point to the Git root, not a subdirectory.',
            ]);
          const report = await checkAcceptance({
            cwd: root,
            configPath: approved.configPath ?? 'donegauge.json',
            execute: true,
            approvedConfigSha256: approved.approvedConfigSha256,
            signal: exec.signal,
          });
          exec.signal.throwIfAborted();
          const reports = await writeReports(root, report);
          return {
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
                    c.evidence.exitCode === null
                      ? null
                      : `exit ${c.evidence.exitCode}`,
                    c.evidence.signal,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : '',
              targetTests: c.testEvidence?.counts.targets ?? 0,
              executedTargetTests: c.testEvidence?.counts.executedTargets ?? 0,
              testEvidencePath: c.testEvidence?.source.path ?? '',
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
            text: [
              `DoneGauge: ${report.task}`,
              `${report.summary.PASS} verified, ${report.summary.FAIL} failed, ${report.summary.UNVERIFIED} unverified, ${report.summary.ERROR} errors`,
              ...report.criteria.map((c) => {
                const summary = `[${c.status}] ${c.id}: ${c.reason}`;
                const evidence = c.evidence
                  ? ` Evidence ID: ${c.evidence.id}.`
                  : '';
                const junit = c.testEvidence;
                if (!junit) return summary + evidence;
                const tests = junit.selections.map((selection) => {
                  const outcome =
                    selection.matches.length === 1
                      ? junit.cases[selection.matches[0]!]!.outcome
                      : selection.matches.length
                        ? 'ambiguous'
                        : 'missing';
                  return `${selection.selector.name}: ${outcome}`;
                });
                return (
                  summary +
                  evidence +
                  ` Targets executed: ${junit.counts.executedTargets}/${junit.counts.targets}; XML: ${junit.source.path}; tests: ${tests.join(', ')}`
                );
              }),
              ...report.warnings,
              `Final status: ${report.finalStatus}`,
            ].join('\n'),
          };
        } catch (error) {
          exec.signal.throwIfAborted();
          if (error instanceof ToolArgsError) throw error;
          throw new ToolArgsError([errorMessage(error)]);
        } finally {
          running = false;
        }
      },
    }),
  );
}
