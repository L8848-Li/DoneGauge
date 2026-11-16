import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Local teaching fixture; this in-memory store is not a production auth system.
export class UserStore {
  users = new Map();

  register(email, password) {
    const key = email.trim().toLowerCase();
    if (this.users.has(key)) throw new Error('Email already registered');
    if (password.length < 8)
      throw new Error('Password must have at least 8 characters');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 32).toString('hex');
    this.users.set(key, { email: key, passwordHash: `scrypt:${salt}:${hash}` });
    return this.users.get(key);
  }

  login(email, password) {
    const user = this.users.get(email.trim().toLowerCase());
    if (!user) return false;
    const [, salt, hash] = user.passwordHash.split(':');
    return timingSafeEqual(
      scryptSync(password, salt, 32),
      Buffer.from(hash, 'hex'),
    );
  }
}
