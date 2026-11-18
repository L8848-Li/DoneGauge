import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { checkAcceptance } from '../src/core/check.js';
import { loadConfig } from '../src/core/config.js';
import { newRepo, saveConfig } from './helpers.js';

const faults = [
  [
    'node-registration',
    'registration.mjs',
    'duplicate-email',
    "if (this.users.has(key)) throw new Error('Email already registered');",
    '',
  ],
  [
    'node-registration',
    'registration.mjs',
    'password-hash',
    '`scrypt:${salt}:${hash}`',
    'password',
  ],
  [
    'node-registration',
    'registration.mjs',
    'password-hash',
    "randomBytes(16).toString('hex')",
    "'a'.repeat(32)",
  ],
  [
    'node-registration',
    'registration.mjs',
    'login',
    'if (!user) return false;',
    'return Boolean(user);',
  ],
  [
    'python-cart',
    'cart.py',
    'test_exact_total',
    'sum(amounts, Decimal("0"))',
    'Decimal(str(sum(float(amount) for amount in amounts)))',
  ],
  [
    'python-cart',
    'cart.py',
    'test_negative_price',
    'if any(amount < 0 for amount in amounts):',
    'if sum(amounts) < 0:',
  ],
] as const;

for (const [example, file, id, before, after] of faults) {
  test(`${example} detects controlled regression for ${id} (${after || 'guard removed'})`, async (t) => {
    const root = await newRepo(t, example);
    const source = join(root, file);
    const implementation = await readFile(source, 'utf8');
    assert.equal(
      implementation.split(before).length,
      2,
      'Fault must target one code fragment.',
    );
    await writeFile(source, implementation.replace(before, after));

    const { config } = await loadConfig(root, 'donegauge.junit.json');
    const criterion = config.criteria.find((item) => item.id === id);
    assert.ok(criterion?.check && criterion.check.kind === 'junit');
    criterion.check.command[0] =
      example === 'python-cart'
        ? (process.env.DONEGAUGE_PYTHON ?? 'python3')
        : process.execPath;
    await saveConfig(root, { ...config, criteria: [criterion] });

    const report = await checkAcceptance({ cwd: root, execute: true });
    const result = report.criteria[0];
    assert.equal(result?.status, 'FAIL', JSON.stringify(result));
    assert.equal(result.evidence?.exitCode, 1);
    assert.equal(result.testEvidence?.counts.executedTargets, 1);
    assert.ok(
      result.testEvidence?.cases.some((item) => item.outcome === 'failed'),
    );
  });
}
