import type { Context } from '@deepseek-ai/cordis';
import {
  defineTool,
  ToolArgsError,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import { sha256 } from '../../core/config.js';
import { repositoryRoot } from '../../core/git.js';
import { suggestTests } from '../../review/suggestions.js';
import { checkAcceptance } from '../../core/check.js';
import { errorMessage } from '../../core/errors.js';
import { discoverTests } from '../../review/discovery.js';
import {
  authorizePlan,
  compilePlan,
  createPlan,
  loadPlan,
  savePlan,
} from '../../review/plan.js';
import { readSharedResult } from '../../review/shared-result.js';
import { writeReports } from '../../reporters/index.js';
import { reportOutput, reportResult } from './report.js';

const handoff = (draft: string) => 'donegauge review --draft ' + draft;
const revision = (digest: string) => sha256('dsh-preview-v1:' + digest);
const encoded = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\p{Cf}\u007f-\u009f\u2028\u2029]/gu,
    (char) => '\\u{' + char.codePointAt(0)!.toString(16) + '}',
  );
const fail = (message: string): never => {
  throw new ToolArgsError([message]);
};
const fields = (args: object, allowed: string[]) => {
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    fail('Unexpected guided review arguments.');
};
async function guarded<T>(exec: ToolRunContext, work: () => Promise<T>) {
  exec.signal.throwIfAborted();
  try {
    return await work();
  } catch (error) {
    exec.signal.throwIfAborted();
    if (error instanceof ToolArgsError) throw error;
    return fail(errorMessage(error));
  }
}

export function registerGuidedReview(
  ctx: Context,
  boundRoot: (signal: AbortSignal) => Promise<string>,
  exclusive: <T>(work: () => Promise<T>) => Promise<T>,
) {
  async function sessionRoot(exec: ToolRunContext) {
    const root = await boundRoot(exec.signal);
    const cwd = exec.agent?.session.header.cwd;
    if (cwd && (await repositoryRoot(cwd, exec.signal)) !== root)
      return fail(
        'This DSH session is not in the configured project. Switch workspace before reviewing.',
      );
    return root;
  }
  ctx.tools.register(
    defineTool({
      name: 'donegauge_review',
      description:
        'Prepare a local review draft only. Quote a requirement the user supplied for this review, or reopen a draft ID. If no requirement is selected, ask the user to paste it. No history access, tests, model request or approval.',
      parameters: { task: { type: 'string' }, draft: { type: 'string' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            draft: { type: 'string', required: true },
            revision: { type: 'string', required: true },
            runnable: { type: 'integer', required: true },
            canRequestApproval: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        return guarded(exec, async () => {
          fields(args, ['task', 'draft']);
          if (args.task !== undefined && args.draft !== undefined)
            return fail('Choose either task text or an existing draft.');
          if (args.task === undefined && args.draft === undefined)
            return {
              draft: '',
              revision: '',
              runnable: 0,
              canRequestApproval: false,
              text: 'Please paste the original requirement or provide a saved draft ID. No chat history was read. No checks ran.',
            };
          const root = await sessionRoot(exec);
          const { candidates, incomplete } = await discoverTests(
            root,
            exec.signal,
          );
          const plan =
            args.draft !== undefined
              ? await loadPlan(root, args.draft)
              : createPlan(args.task!, candidates);
          exec.signal.throwIfAborted();
          const draft = args.draft ?? (await savePlan(root, plan));
          const { selected, digest } = compilePlan(
            root,
            draft,
            plan,
            candidates,
          );
          const runnable = selected.filter(Boolean).length;
          const canRequestApproval = Boolean(
            exec.agent && ctx.get('approval')?.request,
          );
          const token = revision(digest);
          const lines = plan.items.slice(0, 8).map((item, index) => {
            const test = selected[index];
            const label = encoded(item.description) + ' — ';
            if (item.excluded) return label + 'excluded';
            if (test)
              return (
                label +
                encoded(test.name) +
                ' (' +
                encoded(test.file) +
                ':' +
                test.line +
                ')'
              );
            const hint = suggestTests(item.description, candidates)[0];
            return (
              label +
              'no bound test; review manually' +
              (hint
                ? ' (possible name match, not coverage: ' +
                  encoded(hint.name) +
                  ')'
                : '')
            );
          });
          const text = [
            'Draft preview only. No tests ran. Task: ' + encoded(plan.task),
            ...lines,
            ...(plan.items.length > 8
              ? ['Showing 8/' + plan.items.length + ' items.']
              : []),
            ...(incomplete
              ? ['Discovery limited; results may be incomplete.']
              : []),
            runnable + '/' + plan.items.length + ' runnable.',
            'Draft: ' + draft,
            'Revision: ' + token,
            'Human CLI review/edit: ' + handoff(draft),
            canRequestApproval
              ? 'DSH can request a separate one-time decision for this revision.'
              : 'No routable host approval. Ask the user to review locally; do not run the CLI on their behalf.',
            'For optional counts-only handback the user can add --share-with-dsh to the local command.',
          ].join('\n');
          return { draft, revision: token, runnable, canRequestApproval, text };
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'donegauge_review_run',
      description:
        'Request a human decision for the exact previewed draft revision. A revision is not permission. No command, path or approval arguments.',
      parameters: {
        draft: { type: 'string', required: true },
        revision: { type: 'string', required: true },
      },
      output: reportOutput,
      async execute(args, exec) {
        return guarded(exec, () =>
          exclusive(async () => {
            fields(args, ['draft', 'revision']);
            const root = await sessionRoot(exec);
            const plan = await loadPlan(root, args.draft);
            const approval = ctx.get('approval');
            if (!exec.agent || !approval?.request)
              return fail(
                'No routable human approval. Ask the user to review locally: ' +
                  handoff(args.draft),
              );
            const { candidates } = await discoverTests(root, exec.signal);
            const { selected, digest, configText } = compilePlan(
              root,
              args.draft,
              plan,
              candidates,
            );
            if (revision(digest) !== args.revision)
              return fail(
                'Draft or bound tests changed. Preview the draft again.',
              );
            if (!selected.some(Boolean))
              return fail(
                'No runnable tests. Edit the draft or keep it for manual review.',
              );
            const reason =
              'Run these local checks once with your user permissions? The checks can change files or access the network. Logs and evidence are saved under .donegauge.\nProject: ' +
              encoded(root) +
              (plan.proposal?.question
                ? '\nUnresolved planning question: ' +
                  encoded(plan.proposal.question)
                : '') +
              '\n' +
              encoded(JSON.parse(configText)) +
              '\nRevision: ' +
              args.revision;
            if (reason.length > 12_000)
              return fail(
                'Plan is too large for a complete host approval prompt. Ask the user to review locally: ' +
                  handoff(args.draft),
              );
            const decision = await approval.request({
              agent: exec.agent,
              toolName: exec.name,
              callId: exec.callId,
              reason,
              signal: exec.signal,
            });
            exec.signal.throwIfAborted();
            if (decision === 'unavailable')
              return fail(
                'Host approval unavailable. Ask the user to review locally: ' +
                  handoff(args.draft),
              );
            if (decision !== 'allowed-once')
              return fail(
                'Host approval did not grant this run. No checks started.',
              );
            const approved = await authorizePlan(
              root,
              args.draft,
              digest,
              exec.signal,
            );
            const report = await checkAcceptance({
              cwd: root,
              ...approved,
              execute: true,
              signal: exec.signal,
            });
            exec.signal.throwIfAborted();
            return reportResult(report, await writeReports(root, report));
          }),
        );
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'donegauge_review_result',
      description:
        'Return only a local CLI result explicitly shared by the user. Requires their exact draft and run IDs. Does not rerun checks or read logs.',
      parameters: {
        draft: { type: 'string', required: true },
        runId: { type: 'string', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runId: { type: 'string', required: true },
            finalStatus: reportOutput.schema.properties.finalStatus,
            summary: reportOutput.schema.properties.summary,
            reports: reportOutput.schema.properties.reports,
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        return guarded(exec, async () => {
          fields(args, ['draft', 'runId']);
          const root = await sessionRoot(exec);
          const result = await readSharedResult(
            root,
            args.draft,
            args.runId,
          ).catch(() =>
            fail(
              'No valid shared summary for these IDs. No reports were searched.',
            ),
          );
          const counts = Object.entries(result.summary)
            .map(([key, count]) => key + ' ' + count)
            .join(' / ');
          return {
            ...result,
            text: [
              result.finalStatus + ' · ' + counts,
              'Run: ' + result.runId,
              'Markdown: ' + result.reports.markdown,
              'JSON: ' + result.reports.json,
            ].join('\n'),
          };
        });
      },
    }),
  );
}
