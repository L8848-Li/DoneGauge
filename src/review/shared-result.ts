import { constants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcceptanceReport } from '../core/types.js';
import { draftDirectory } from './plan.js';

export async function shareResult(
  root: string,
  draft: string,
  report: AcceptanceReport,
) {
  const directory = await draftDirectory(root, draft, false);
  await writeFile(
    join(directory, 'shared-' + report.runId + '.json'),
    JSON.stringify({
      draft,
      runId: report.runId,
      finalStatus: report.finalStatus,
      summary: report.summary,
    }),
    { flag: 'wx', mode: 0o600 },
  );
}

export async function readSharedResult(
  root: string,
  draft: string,
  runId: string,
) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId))
    throw new Error('Expected a run ID, not a path.');
  const directory = await draftDirectory(root, draft, false);
  const path = join(directory, 'shared-' + runId + '.json');
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 2048n)
    throw new Error('Invalid shared result.');
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.size > 2048n ||
      info.ino !== before.ino ||
      info.dev !== before.dev
    )
      throw new Error('Invalid shared result.');
    const data = Buffer.alloc(2049);
    const { bytesRead } = await handle.read(data);
    if (bytesRead !== Number(info.size))
      throw new Error('Incomplete shared result.');
    const value = JSON.parse(data.toString('utf8', 0, bytesRead));
    const finalStatus: unknown = value?.finalStatus;
    if (
      value?.draft !== draft ||
      value.runId !== runId ||
      (finalStatus !== 'VERIFIED' && finalStatus !== 'REVIEW REQUIRED')
    )
      throw new Error('Invalid shared result identity.');
    const count = (key: string): number => {
      const number = value.summary?.[key];
      if (!Number.isSafeInteger(number) || number < 0 || number > 100)
        throw new Error('Invalid result counts.');
      return number;
    };
    const summary = {
      PASS: count('PASS'),
      FAIL: count('FAIL'),
      UNVERIFIED: count('UNVERIFIED'),
      ERROR: count('ERROR'),
    };
    const total = Object.values(summary).reduce((sum, item) => sum + item, 0);
    if (
      total < 1 ||
      total > 100 ||
      (finalStatus === 'VERIFIED' && total !== summary.PASS)
    )
      throw new Error('Inconsistent shared result.');
    return {
      runId,
      finalStatus,
      summary,
      reports: {
        json: '.donegauge/runs/' + runId + '/report.json',
        markdown: '.donegauge/runs/' + runId + '/report.md',
      },
    } as const;
  } finally {
    await handle.close();
  }
}
