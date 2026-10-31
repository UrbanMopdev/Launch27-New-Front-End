import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Sign-in sessions: session id -> { bearer, email, expires }.
//
// Reads are synchronous from memory. With a database, sessions are also written to the
// `sessions` table (bearer token encrypted with a key derived from SESSION_SECRET, id
// stored only as a SHA-256 hash), and hydrate() reloads one on demand — so signing in
// survives redeploys and works across several instances.
export class SessionStore {
  constructor({ db = null, secret = 'dev-only-secret', log = () => {} } = {}) {
    this.sessions = new Map();
    this.db = db;
    this.key = createHash('sha256').update(`session-key:${secret}`).digest();
    this.log = log;
  }

  create(bearer, email) {
    const id = randomBytes(32).toString('hex');
    const expires = Date.now() + MAX_AGE_MS;
    this.sessions.set(id, { bearer, email, expires });
    if (this.db) {
      this.db
        .query('INSERT INTO sessions (id, user_email, bearer_enc, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [hashId(id), email.toLowerCase(), this.encrypt(bearer), new Date(expires)])
        .catch((err) => this.log('error', 'session persist failed', { error: err.message }));
    }
    return id;
  }

  get(id) {
    const session = id && this.sessions.get(id);
    if (!session) return null;
    if (session.expires < Date.now()) {
      this.delete(id);
      return null;
    }
    return session;
  }

  delete(id) {
    if (!id) return;
    this.sessions.delete(id);
    this.db?.query('DELETE FROM sessions WHERE id = $1', [hashId(id)]).catch((err) => this.log('error', 'session delete failed', { error: err.message }));
  }

  /** Load a session from the database into memory if it isn't there yet. */
  async hydrate(id) {
    if (!this.db || !id || this.sessions.has(id)) return;
    const row = (await this.db.query('SELECT user_email, bearer_enc, expires_at FROM sessions WHERE id = $1 AND expires_at > now()', [hashId(id)])).rows[0];
    if (!row) return;
    try {
      this.sessions.set(id, { bearer: this.decrypt(row.bearer_enc), email: row.user_email, expires: new Date(row.expires_at).getTime() });
    } catch {
      // Secret rotated or row tampered with: treat as signed out.
    }
  }

  async purgeExpired() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expires < now) this.sessions.delete(id);
    if (this.db) await this.db.query('DELETE FROM sessions WHERE expires_at < now()');
  }

  encrypt(text) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
  }

  decrypt(payload) {
    const [iv, tag, ct] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}

const hashId = (id) => createHash('sha256').update(id).digest('hex');

export const COOKIE_MAX_AGE_MS = MAX_AGE_MS;
