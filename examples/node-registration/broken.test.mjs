import assert from 'node:assert/strict';
import test from 'node:test';
import { BrokenUserStore } from './broken-registration.mjs';

test('login after registration in the regressed implementation', () => {
  const store = new BrokenUserStore();
  store.register('ada@example.test', 'correct-password');
  assert.equal(store.login('ada@example.test', 'correct-password'), true);
});
