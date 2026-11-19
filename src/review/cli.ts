import { createInterface } from 'node:readline/promises';
import { terminalSafe } from '../reporters/index.js';
import { DoneGaugeError } from '../core/errors.js';
import { discoverTests, type Candidate } from './discovery.js';
import { suggestTests } from './suggestions.js';
import { prepareRequest, requestProposal, proposalFrom } from './planner.js';
import {
  authorizePlan,
  compilePlan,
  createPlan,
  loadPlan,
  savePlan,
  type ReviewPlan,
} from './plan.js';

interface Options {
  task?: string;
  draft?: string;
  approve?: string;
  json?: boolean;
  ai?: boolean;
  send?: string;
  'omit-tests'?: boolean;
}

const say = (text: string) => process.stdout.write(terminalSafe(text) + '\n');

function preview(
  root: string,
  id: string,
  plan: ReviewPlan,
  candidates: Candidate[],
  incomplete: boolean,
  json: boolean,
  notice?: string,
) {
  const { digest, selected } = compilePlan(root, id, plan, candidates);
  const items = plan.items.map((item, index) => ({
    ...item,
    test: selected[index] ?? null,
    suggestions:
      !item.excluded && !selected[index]
        ? suggestTests(item.description, candidates)
        : [],
  }));
  const runnable = selected.filter(Boolean).length;
  if (json) {
    sayJson({
      kind: 'review-preview',
      planner: plan.proposal ? 'model-proposal' : 'local-rules',
      ...(plan.proposal ? { proposal: plan.proposal } : {}),
      ...(notice ? { notice } : {}),
      draft: id,
      digest,
      task: plan.task,
      runnable,
      incomplete,
      items,
      candidates,
    });
    return digest;
  }
  if (notice) say(notice);
  say(
    `Review draft — no tests executed.\nTask: ${plan.task}\nDraft: .donegauge/reviews/${id}/plan.json`,
  );
  if (plan.proposal) {
    say(
      `Model proposal: ${plan.proposal.model}. Compare with unchanged draft: ${plan.proposal.parent}`,
    );
    if (plan.proposal.question)
      say('Clarify before accepting: ' + plan.proposal.question);
  }
  for (const [index, item] of items.entries()) {
    say(
      `${index + 1}. ${item.description} — ${item.excluded ? 'excluded (not verified)' : !item.test ? 'manual / no test bound' : `${item.test.file}:${item.test.line} :: ${item.test.name}`}`,
    );
    if (item.test)
      say(
        `   cwd: ${JSON.stringify(item.test.check.cwd)}  argv: ${JSON.stringify(item.test.check.command)}`,
      );
    if (item.basis)
      say(
        `   Original requirement: ${JSON.stringify(item.basis.source)}\n   Model rationale (not evidence): ${JSON.stringify(item.basis.reason)}`,
      );
    for (const hint of item.suggestions)
      say(
        `   Possible match (shared words: ${hint.shared.join(', ')}): ${hint.file} :: ${hint.name}`,
      );
  }
  say(
    `${runnable}/${items.length} runnable. A matching name is not proof of coverage. Tests run with your user permissions.`,
  );
  if (incomplete)
    say('Discovery was limited; some files or tests were not inspected.');
  say(
    `Preview again: donegauge review --draft ${id}\nList candidate IDs and commands: donegauge review --draft ${id} --json`,
  );
  if (runnable)
    say(
      `Approve this exact draft: donegauge review --draft ${id} --approve ${digest}`,
    );
  return digest;
}

function sayJson(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export async function review(
  root: string,
  options: Options,
  signal: AbortSignal,
) {
  if (
    (options.ai && options.approve !== undefined) ||
    (!options.ai && (options.send !== undefined || options['omit-tests'])) ||
    (options.send !== undefined && !options.draft)
  )
    throw new DoneGaugeError(
      'Model planning and execution approval are separate. Use --ai --draft ID --send DIGEST only after preview.',
      'USAGE',
    );
  if (
    options.draft === '' ||
    (options.task !== undefined && options.draft !== undefined) ||
    (options.approve !== undefined && !options.draft)
  )
    throw new DoneGaugeError(
      'Use --task for a new draft, or --draft ID [--approve DIGEST] to resume.',
      'USAGE',
    );
  if (options.approve !== undefined)
    return authorizePlan(root, options.draft!, options.approve, signal);
  const interactive = Boolean(
    process.stdin.isTTY && process.stdout.isTTY && !options.json,
  );
  const reader = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  reader?.once('SIGINT', () => process.emit('SIGINT'));
  const input = async (prompt: string) => {
    if (!reader)
      throw new DoneGaugeError(
        'Provide --task "requirements" or --draft ID when not using an interactive terminal.',
        'USAGE',
      );
    return (await reader.question(prompt, { signal })).trim();
  };
  try {
    const task = options.draft
      ? null
      : (options.task ??
        (await input(
          'What should the change do? Separate requirements with semicolons.\n> ',
        )));
    const { candidates, incomplete } = await discoverTests(root, signal);
    let plan = options.draft
      ? await loadPlan(root, options.draft)
      : createPlan(task ?? '', candidates);
    let id = options.draft ?? (await savePlan(root, plan));
    let notice: string | undefined;
    if (options.ai) {
      try {
        const request = prepareRequest(
          root,
          id,
          plan,
          candidates,
          options['omit-tests'] ?? false,
        );
        let consent = options.send;
        if (consent === undefined) {
          const disclosure = {
            kind: 'planner-disclosure',
            draft: id,
            endpoint: request.endpoint,
            body: request.body,
            sendDigest: request.digest,
            authorizationHeader: Boolean(process.env.DONEGAUGE_PLANNER_KEY),
            sent: false,
          };
          if (options.json) {
            sayJson(disclosure);
            return null;
          }
          say(
            'Nothing sent. The provider will receive this exact request body (no source files or paths are added):',
          );
          say(JSON.stringify(disclosure, null, 2));
          say(
            `Send once: donegauge review --ai ${options['omit-tests'] ? '--omit-tests ' : ''}--draft ${id} --send ${request.digest}`,
          );
          if (!reader) return null;
          if (
            (await input(
              'Type send to disclose this request, or Enter to keep it local: ',
            )) === 'send'
          )
            consent = request.digest;
        }
        if (consent === undefined)
          notice = 'Nothing sent. Continuing with the unchanged draft.';
        else {
          const content = await requestProposal(request, consent, signal, {
            ...(process.env.DONEGAUGE_PLANNER_KEY
              ? { key: process.env.DONEGAUGE_PLANNER_KEY }
              : {}),
          });
          const proposed = proposalFrom(content, request, id, plan);
          id = await savePlan(root, proposed);
          plan = proposed;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof DoneGaugeError) || error.code === 'TRUST')
          throw error;
        notice =
          'Planner unavailable; kept your original draft. ' + error.message;
      }
      preview(
        root,
        id,
        plan,
        candidates,
        incomplete,
        options.json ?? false,
        notice,
      );
      return null;
    }
    while (true) {
      const digest = preview(
        root,
        id,
        plan,
        candidates,
        incomplete,
        options.json ?? false,
      );
      if (!reader) return null;
      const runnable = plan.items.some(
        (item) =>
          !item.excluded &&
          candidates.some((candidate) => candidate.id === item.candidateId),
      );
      const action = await input(
        runnable
          ? '[Enter] Save and exit | edit | run: '
          : '[Enter] Save and exit | edit: ',
      );
      if (!action || action === 'save') return null;
      if (action === 'run' && runnable)
        return authorizePlan(root, id, digest, signal);
      if (action !== 'edit') {
        say(
          runnable
            ? 'Type edit or run, or press Enter to leave the draft saved.'
            : 'No tests bound. Type edit to bind a test, or press Enter to save.',
        );
        continue;
      }
      const indexText = await input('Item number to edit, or + to add: ');
      const index =
        indexText === '+' ? plan.items.length : Number(indexText) - 1;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= (indexText === '+' ? 100 : plan.items.length)
      ) {
        say('Choose a listed item number (maximum 100 items).');
        continue;
      }
      const old = plan.items[index];
      const description = await input(
        old ? `Requirement (Enter to keep): ` : 'New requirement: ',
      );
      if ((!description && !old) || description.length > 1900) {
        say('Enter a requirement of 1–1900 characters.');
        continue;
      }
      candidates.forEach((candidate, position) =>
        say(
          `${position + 1}. ${candidate.file}:${candidate.line} :: ${candidate.name}`,
        ),
      );
      const choice = await input(
        'Test number | manual | exclude | Enter to keep: ',
      );
      const candidate = /^\d+$/.test(choice)
        ? candidates[Number(choice) - 1]
        : undefined;
      if (choice && !candidate && !['manual', 'exclude'].includes(choice)) {
        say('No such candidate. No changes saved.');
        continue;
      }
      plan.items[index] = {
        locked: true,
        description: description || old!.description,
        candidateId: choice
          ? (candidate?.id ?? null)
          : (old?.candidateId ?? null),
        excluded: choice ? choice === 'exclude' : (old?.excluded ?? false),
      };
      await savePlan(root, plan, id);
    }
  } finally {
    reader?.close();
  }
}
