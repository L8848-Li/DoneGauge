import { createInterface } from 'node:readline/promises';
import { terminalSafe } from '../reporters/index.js';
import { DoneGaugeError } from '../core/errors.js';
import { discoverTests, type Candidate } from './discovery.js';
import { suggestTests } from './suggestions.js';
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
}

const say = (text: string) => process.stdout.write(terminalSafe(text) + '\n');

function preview(
  root: string,
  id: string,
  plan: ReviewPlan,
  candidates: Candidate[],
  incomplete: boolean,
  json: boolean,
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
      planner: 'local-rules',
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
  say(
    `Local review draft — no tests executed.\nTask: ${plan.task}\nDraft: .donegauge/reviews/${id}/plan.json`,
  );
  for (const [index, item] of items.entries()) {
    say(
      `${index + 1}. ${item.description} — ${item.excluded ? 'excluded (not verified)' : !item.test ? 'manual / no test bound' : `${item.test.file}:${item.test.line} :: ${item.test.name}`}`,
    );
    if (item.test)
      say(
        `   cwd: ${JSON.stringify(item.test.check.cwd)}  argv: ${JSON.stringify(item.test.check.command)}`,
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
    const plan = options.draft
      ? await loadPlan(root, options.draft)
      : createPlan(task ?? '', candidates);
    const id = options.draft ?? (await savePlan(root, plan));
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
