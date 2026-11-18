import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import test from 'node:test';
import { UserStore } from './registration.mjs';

test('duplicate email is rejected', () => {
  const store = new UserStore();
  store.register('ada@example.test', 'correct-password');
  assert.throws(
    () => store.register(' ADA@example.test ', 'another-password'),
    /already registered/,
  );
  assert.equal(store.users.size, 1);
  assert.equal(store.login('ada@example.test', 'correct-password'), true);
});

test('password is hashed with per-user salt', () => {
  const store = new UserStore();
  const first = store.register('ada@example.test', 'correct-password');
  const second = store.register('grace@example.test', 'correct-password');
  assert.match(first.passwordHash, /^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/);
  assert.match(second.passwordHash, /^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/);
  const [, firstSalt, firstHash] = first.passwordHash.split(':');
  const [, secondSalt] = second.passwordHash.split(':');
  assert.notEqual(firstSalt, secondSalt);
  assert.equal(
    firstHash,
    scryptSync('correct-password', firstSalt, 32).toString('hex'),
  );
  assert.notEqual(first.passwordHash, second.passwordHash);
  assert.ok(!first.passwordHash.includes('correct-password'));
  assert.ok(!('password' in first));
});

test('login after registration', () => {
  const store = new UserStore();
  store.register('ada@example.test', 'correct-password');
  assert.equal(store.login(' ADA@example.test ', 'correct-password'), true);
  assert.equal(store.login('ada@example.test', 'wrong-password'), false);
  assert.equal(store.login('unknown@example.test', 'correct-password'), false);
});
