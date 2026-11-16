import { UserStore } from './registration.mjs';

// Intentional regression fixture: the new login implementation cannot log in.
export class BrokenUserStore extends UserStore {
  login() {
    return false;
  }
}
