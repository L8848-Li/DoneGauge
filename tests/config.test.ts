import assert from 'node:assert/strict';
import test from 'node:test';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, parseConfig, projectPath } from '../src/core/config.js';
import { configWith, tempDirectory } from './helpers.js';

test('valid config supports a command contract and optional missing evidence', () => {
  assert.equal(
    parseConfig(JSON.stringify(configWith(['node', '--test']))).criteria[0]
      ?.check?.command[1],
    '--test',
  );
  assert.equal(
    parseConfig(JSON.stringify(configWith())).criteria[0]?.check,
    undefined,
  );
});

test('explicit command kind preserves the existing exit/output contract', () => {
  const config = configWith(['node', '--test']);
  Object.assign(config.criteria[0]!.check!, {
    kind: 'command',
    expect: { exitCode: 1, stdoutIncludes: 'expected failure' },
  });
  assert.deepEqual(parseConfig(JSON.stringify(config)), config);
});

const bad: [string, unknown, RegExp][] = [
  ['missing task', { version: 1, criteria: [] }, /task/],
  ['wrong version', { ...configWith(), version: 2 }, /version/],
  ['unknown field', { ...configWith(), taks: 'typo' }, /unknown field.*taks/],
  [
    'shell string',
    {
      ...configWith(),
      criteria: [
        { id: 'a', description: 'A', check: { command: 'node --test' } },
      ],
    },
    /command.*array/,
  ],
  ['empty command', configWith([]), /executable/],
  ['blank executable', configWith([' ']), /executable/],
  ['NUL executable', configWith(['node\0']), /command/],
  ['blank task', { ...configWith(), task: '  ' }, /task/],
  [
    'duplicate ids',
    {
      ...configWith(),
      criteria: [configWith().criteria[0], configWith().criteria[0]],
    },
    /Duplicate/,
  ],
  [
    'invalid timeout',
    {
      ...configWith(),
      criteria: [
        {
          id: 'a',
          description: 'A',
          check: { command: ['node'], timeoutMs: 0 },
        },
      ],
    },
    /timeoutMs/,
  ],
  [
    'unexpected expectation',
    {
      ...configWith(),
      criteria: [
        {
          id: 'a',
          description: 'A',
          check: { command: ['node'], expect: { score: 1 } },
        },
      ],
    },
    /unknown field.*score/,
  ],
];
for (const [name, value, error] of bad)
  test(`config rejects ${name} with useful error`, () =>
    assert.throws(() => parseConfig(JSON.stringify(value)), error));

test('invalid JSON explains how to fix the file', () =>
  assert.throws(() => parseConfig('{'), /commas, quotes/));

test('config read has digest and rejects missing files and outside symlinks', async (t) => {
  const root = await tempDirectory(t);
  const other = await tempDirectory(t);
  await writeFile(join(root, 'donegauge.json'), JSON.stringify(configWith()));
  assert.match((await loadConfig(root)).sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(loadConfig(root, 'missing.json'), /Check the path/);
  await symlink(
    other,
    join(root, 'outside'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    projectPath(root, 'outside', 'working directory'),
    /inside the project/,
  );
});
