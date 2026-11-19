import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseConfig, sha256 } from '../core/config.js';
import { DoneGaugeError } from '../core/errors.js';
import { discoverTests, type Candidate } from './discovery.js';

export interface ReviewPlan {
  planVersion: 1;
  task: string;
  proposal?: { parent: string; model: string; question: string | null };
  items: {
    description: string;
    candidateId: string | null;
    excluded: boolean;
    locked?: true;
    basis?: { source: string; reason: string };
  }[];
}

const invalid = (message: string): never => {
  throw new DoneGaugeError(message, 'CONFIG');
};
const nonempty = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const normal = (value: string) =>
  value
    .toLowerCase()
    .replace(/^test_/, '')
    .replace(/[_\s]+/gu, ' ')
    .trim();

export function createPlan(task: string, candidates: Candidate[]): ReviewPlan {
  if (!nonempty(task, 500))
    return invalid(
      'Provide 1–500 characters of requirements (separate items with a newline or semicolon).',
    );
  const parts = task
    .split(/[\n;；。]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 100)
    return invalid('A plan needs between 1 and 100 requirements.');
  return {
    planVersion: 1,
    task,
    items: parts.map((description) => {
      const key = normal(description);
      const matches = candidates.filter(
        (candidate) => key && normal(candidate.name) === key,
      );
      return {
        description,
        candidateId: matches.length === 1 ? matches[0]!.id : null,
        excluded: false,
      };
    }),
  };
}

export function parsePlan(text: string): ReviewPlan {
  const data = JSON.parse(text) as Partial<ReviewPlan> | null;
  if (
    !data ||
    Object.keys(data).some(
      (key) => !['planVersion', 'task', 'items', 'proposal'].includes(key),
    ) ||
    data.planVersion !== 1 ||
    !nonempty(data.task, 500) ||
    !Array.isArray(data.items) ||
    !data.items.length ||
    data.items.length > 100
  )
    return invalid(
      'Invalid review draft. Regenerate it with donegauge review --task.',
    );
  if (data.proposal !== undefined) {
    const meta = data.proposal;
    if (
      !meta ||
      Object.keys(meta).some(
        (key) => !['parent', 'model', 'question'].includes(key),
      ) ||
      !nonempty(meta.parent, 36) ||
      !nonempty(meta.model, 160) ||
      (meta.question !== null && !nonempty(meta.question, 500))
    )
      return invalid('Invalid review proposal metadata.');
  }
  for (const item of data.items) {
    if (
      !item ||
      Object.keys(item).some(
        (key) =>
          ![
            'description',
            'candidateId',
            'excluded',
            'locked',
            'basis',
          ].includes(key),
      ) ||
      (item.locked !== undefined && item.locked !== true) ||
      (item.basis !== undefined &&
        (!item.basis ||
          Object.keys(item.basis).some(
            (key) => !['source', 'reason'].includes(key),
          ) ||
          !nonempty(item.basis.source, 1900) ||
          !nonempty(item.basis.reason, 500))) ||
      !nonempty(item.description, 1900) ||
      typeof item.excluded !== 'boolean' ||
      (item.candidateId !== null &&
        (typeof item.candidateId !== 'string' ||
          !/^[a-f0-9]{24}$/.test(item.candidateId)))
    )
      return invalid(
        'Invalid review item. Use a discovered candidate ID or null for a manual check.',
      );
  }
  return data as ReviewPlan;
}

export function compilePlan(
  root: string,
  id: string,
  plan: ReviewPlan,
  candidates: Candidate[],
) {
  const selected = plan.items.map((item) =>
    item.excluded
      ? undefined
      : candidates.find((candidate) => candidate.id === item.candidateId),
  );
  const config = parseConfig(
    JSON.stringify({
      version: 1,
      task: plan.task,
      criteria: plan.items.map((item, index) => ({
        id: `AC-${index + 1}`,
        description: item.excluded
          ? `[Excluded from run] ${item.description}`
          : item.description,
        ...(selected[index] ? { check: selected[index].check } : {}),
      })),
    }),
  );
  const configText = JSON.stringify(config, null, 2) + '\n';
  const digest = sha256(
    JSON.stringify([
      root,
      id,
      plan,
      configText,
      selected.map((candidate) => candidate?.sourceSha256 ?? null),
    ]),
  );
  return { configText, digest, selected };
}

async function draftDirectory(root: string, draftId: string, create: boolean) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(draftId))
    return invalid('Expected a review draft ID, not a path.');
  let directory = root;
  for (const segment of ['.donegauge', 'reviews', draftId]) {
    directory = join(directory, segment);
    if (create)
      await mkdir(directory, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST' || segment === draftId) throw error;
        },
      );
    if (!(await lstat(directory)).isDirectory())
      return invalid(
        'Review storage must use normal project directories, not symlinks.',
      );
  }
  return directory;
}

export async function savePlan(
  root: string,
  plan: ReviewPlan,
  existingId?: string,
) {
  const id = existingId ?? randomUUID();
  const directory = await draftDirectory(root, id, existingId === undefined);
  const path = join(directory, 'plan.json');
  const temporary = join(directory, `draft-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(plan, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporary, path);
  return id;
}

export async function loadPlan(root: string, id: string) {
  const path = join(await draftDirectory(root, id, false), 'plan.json');
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1_048_576)
    return invalid('Review draft must be a normal file of at most 1 MiB.');
  return parsePlan(await readFile(path, 'utf8'));
}

export async function saveRunConfig(root: string, id: string, text: string) {
  const path = join(
    await draftDirectory(root, id, false),
    `run-${randomUUID()}.json`,
  );
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  return relative(root, path);
}

export async function authorizePlan(
  root: string,
  id: string,
  approved: string,
  signal: AbortSignal,
) {
  const plan = await loadPlan(root, id);
  const { candidates } = await discoverTests(root, signal);
  const compiled = compilePlan(root, id, plan, candidates);
  if (compiled.digest !== approved)
    throw new DoneGaugeError(
      'The plan, test source, interpreter or project differs from the reviewed preview. Preview the draft again before approving.',
      'TRUST',
    );
  if (!compiled.selected.some(Boolean))
    return invalid(
      'No runnable tests selected. Keep these requirements for manual review.',
    );
  signal.throwIfAborted();
  return {
    configPath: await saveRunConfig(root, id, compiled.configText),
    approvedConfigSha256: sha256(compiled.configText),
  };
}
