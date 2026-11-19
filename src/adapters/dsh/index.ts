import { isAbsolute } from 'node:path';
import { registerGuidedReview } from './guided.js';
import { realpath } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools';
import { checkAcceptance } from '../../core/check.js';
import { errorMessage } from '../../core/errors.js';
import { repositoryRoot } from '../../core/git.js';
import { writeReports } from '../../reporters/index.js';
import { reportResult, reportOutput } from './report.js';

export const name = 'donegauge';
export const inject = ['tools'];

export interface DshConfig {
  root?: string;
  guidedReview?: boolean;
  configPath?: string;
  approvedConfigSha256?: string;
}

export function apply(ctx: Context, config: DshConfig = {}): void {
  // Deployment config is human-authored, never supplied as model arguments.
  for (const key of Object.keys(config)) {
    if (
      !['root', 'configPath', 'approvedConfigSha256', 'guidedReview'].includes(
        key,
      )
    )
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
  if (
    config.guidedReview !== undefined &&
    typeof config.guidedReview !== 'boolean'
  )
    throw new Error('guidedReview must be boolean.');
  const approved = { ...config };
  let running = false;
  async function boundRoot(signal: AbortSignal) {
    if (!approved.root)
      throw new ToolArgsError([
        'Set the project root in the human-owned DSH overlay.',
      ]);
    const root = await repositoryRoot(approved.root, signal);
    if (root !== (await realpath(approved.root)))
      throw new ToolArgsError(['DoneGauge root must be the Git root.']);
    return root;
  }
  async function exclusive<T>(work: () => Promise<T>) {
    if (running)
      throw new ToolArgsError([
        'A DoneGauge check is already running. Wait for it to finish.',
      ]);
    running = true;
    try {
      return await work();
    } finally {
      running = false;
    }
  }
  if (approved.guidedReview) registerGuidedReview(ctx, boundRoot, exclusive);
  ctx.tools.register(
    defineTool({
      name: 'donegauge_check',
      description:
        'Run the approved project checks once per acceptance verification request. No arguments.',
      parameters: {},
      output: reportOutput,
      async execute(args, exec) {
        if (Object.keys(args).length)
          throw new ToolArgsError([
            'donegauge_check accepts no arguments. Configure the project and commands in the human-owned DSH patch and donegauge.json.',
          ]);
        if (!approved.root || !approved.approvedConfigSha256)
          throw new ToolArgsError([
            'DoneGauge is not configured. Set root and approvedConfigSha256 in a local DSH --patch overlay. See docs/dsh.md.',
          ]);
        const approvedConfigSha256 = approved.approvedConfigSha256;
        exec.signal.throwIfAborted();
        return exclusive(async () => {
          try {
            const root = await boundRoot(exec.signal);
            const report = await checkAcceptance({
              cwd: root,
              configPath: approved.configPath ?? 'donegauge.json',
              execute: true,
              approvedConfigSha256,
              signal: exec.signal,
            });
            exec.signal.throwIfAborted();
            const reports = await writeReports(root, report);
            return reportResult(report, reports);
          } catch (error) {
            exec.signal.throwIfAborted();
            if (error instanceof ToolArgsError) throw error;
            throw new ToolArgsError([errorMessage(error)]);
          }
        });
      },
    }),
  );
}
