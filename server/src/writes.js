// Write log: every change this app sends to Launch27, from any screen, is recorded here
// before the answer goes back to the user, including attempts blocked because writes are
// off. The log line carries no personal data; the request itself is kept in the database
// (production's own, like the rest of its data) so admins can see exactly what was sent.
const MAX_REQUEST = 20_000;

function parseBody(body) {
  if (body === undefined || body === null || body === '') return null;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body);
  if (text.length > MAX_REQUEST) return { truncated: true, length: text.length, start: text.slice(0, MAX_REQUEST) };
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function bookingIdOf(path, request) {
  const m = String(path).match(/\/bookings\/(\d+)/);
  if (m) return Number(m[1]);
  const ids = request?.booking_ids;
  return Array.isArray(ids) && ids.length === 1 ? Number(ids[0]) || null : null;
}

export function createWriteLog({ db, log = { info() {}, warn() {}, error() {} } }) {
  async function record({ email = null, source, method, path, body, outcome, status = null, error = null }) {
    const request = parseBody(body);
    const cleanPath = String(path).split('?')[0];
    const bookingId = bookingIdOf(cleanPath, request);
    log.info('launch27 write', { source, method, path: cleanPath.replace(/\d{3,}/g, ':id'), outcome, status });
    if (!db) return;
    try {
      await db.query(
        'INSERT INTO l27_writes (user_email, source, method, path, booking_id, outcome, status, request, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)',
        [email, source, method, String(path).slice(0, 500), bookingId, outcome, status, request === null ? null : JSON.stringify(request), error ? String(error).slice(0, 1000) : null],
      );
    } catch (err) {
      // Never lose the user's change because the log failed; say so loudly instead.
      log.error('could not record a Launch27 write', { error: err.message, source, method });
    }
  }
  async function list({ limit = 100, before = null } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = before
      ? (await db.query('SELECT * FROM l27_writes WHERE id < $1 ORDER BY id DESC LIMIT $2', [Number(before), lim])).rows
      : (await db.query('SELECT * FROM l27_writes ORDER BY id DESC LIMIT $1', [lim])).rows;
    const counts = (await db.query("SELECT count(*)::int AS total, count(*) FILTER (WHERE at > now() - interval '24 hours')::int AS day, count(*) FILTER (WHERE outcome = 'done')::int AS done FROM l27_writes")).rows[0];
    return { rows, counts };
  }
  return { record, list };
}
