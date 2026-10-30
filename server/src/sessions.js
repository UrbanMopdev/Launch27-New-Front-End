import { randomBytes } from 'node:crypto';

const MAX_AGE_MS = 12 * 60 * 60 * 1000;

// In-memory session store: session id -> { bearer, email, expires }.
// Sessions are lost on restart and users log in again. Swap for Redis/Postgres
// if this ever runs as more than one instance.
export class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  create(bearer, email) {
    const id = randomBytes(32).toString('hex');
    this.sessions.set(id, { bearer, email, expires: Date.now() + MAX_AGE_MS });
    return id;
  }

  get(id) {
    const session = id && this.sessions.get(id);
    if (!session) return null;
    if (session.expires < Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  delete(id) {
    this.sessions.delete(id);
  }
}

export const COOKIE_MAX_AGE_MS = MAX_AGE_MS;
