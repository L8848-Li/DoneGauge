import { execFile } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';

const execute = promisify(execFile);

export async function execGit(root: string, args: string[]): Promise<string> {
  return (
    await execute('git', args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(root, '.git', 'donegauge-test-global-config'),
        GIT_AUTHOR_NAME: 'DoneGauge Test',
        GIT_AUTHOR_EMAIL: 'test@example.test',
        GIT_COMMITTER_NAME: 'DoneGauge Test',
        GIT_COMMITTER_EMAIL: 'test@example.test',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'commit.gpgsign',
        GIT_CONFIG_VALUE_0: 'false',
      },
    })
  ).stdout;
}

export async function tempDirectory(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'donegauge-test-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export async function newRepo(
  t: TestContext,
  example?: string,
): Promise<string> {
  const root = await tempDirectory(t);
  if (example)
    await cp(resolve('examples', example), root, { recursive: true });
  await writeFile(join(root, '.gitignore'), '.donegauge/\n__pycache__/\n');
  await writeFile(join(root, 'tracked.txt'), 'baseline\n');
  await writeFile(join(root, 'delete.txt'), 'baseline\n');
  await execGit(root, ['init', '-q']);
  await execGit(root, ['add', '--', '.']);
  await execGit(root, ['commit', '-qm', 'Initial test fixture']);
  return root;
}
import type { AcceptanceConfig, AcceptanceReport } from '../src/core/types.js';

const exec = promisify(execFile);
export const projectRoot = resolve(import.meta.dirname, '../..');
export const cli = join(projectRoot, 'dist/src/cli.js');

export async function saveConfig(
  root: string,
  config: AcceptanceConfig,
): Promise<void> {
  await writeFile(
    join(root, 'donegauge.json'),
    JSON.stringify(config, null, 2) + '\n',
  );
}

export function configWith(command?: string[]): AcceptanceConfig {
  return {
    version: 1,
    task: 'Check a real command',
    criteria: [
      {
        id: 'AC-1',
        description: 'The configured assertion holds',
        ...(command ? { check: { command } } : {}),
      },
    ],
  };
}

export async function runCli(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await exec(process.execPath, [cli, ...args], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, ...r };
  } catch (error) {
    const e = error as Error & { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

export async function reportFrom(
  root: string,
  path: string,
): Promise<AcceptanceReport> {
  return JSON.parse(
    await readFile(join(root, path), 'utf8'),
  ) as AcceptanceReport;
}
