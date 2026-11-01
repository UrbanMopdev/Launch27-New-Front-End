// QA copy of real data: production builds and sends it; QA receives, checks and serves it.
import { timingSafeEqual } from 'node:crypto';
import { assertAnonymous } from './anonymize.js';
import { buildSnapshot, summarize } from './snapshot.js';

// QA side: keeps the latest copy in Postgres and in memory for the synthetic Launch27.
export function createQaStore({ db, log }) {
  let current = null;
  let currentSummary = null;
  return {
    async load() {
      const row = (await db.query('SELECT data, summary FROM qa_snapshots ORDER BY received_at DESC LIMIT 1')).rows[0];
      current = row?.data || null;
      currentSummary = row?.summary || null;
      if (current) log.info('serving the anonymized QA copy', currentSummary);
      return currentSummary;
    },
    current: () => current,
    summary: () => currentSummary,
    async save(copy) {
      // Check again on arrival: QA never stores anything that looks personal.
      assertAnonymous(copy);
      if (!Array.isArray(copy?.bookings) || !Array.isArray(copy?.customers) || !Array.isArray(copy?.teams)) throw new Error('Not a QA copy');
      const summary = summarize(copy);
      await db.tx(async (q) => {
        await q.query('INSERT INTO qa_snapshots (created_at, summary, data) VALUES ($1, $2::jsonb, $3::jsonb)', [copy.created_at || new Date(), JSON.stringify(summary), JSON.stringify(copy)]);
        // Keep the last two copies only.
        await q.query('DELETE FROM qa_snapshots WHERE id NOT IN (SELECT id FROM qa_snapshots ORDER BY received_at DESC LIMIT 2)');
      });
      current = copy;
      currentSummary = summary;
      log.info('received an anonymized QA copy', summary);
      return summary;
    },
    async clear() {
      await db.query('DELETE FROM qa_snapshots');
      current = null;
      currentSummary = null;
    },
  };
}

export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Production side: one refresh at a time, run in the background with the admin's token.
export function createQaSender({ config, fetchImpl = fetch, log }) {
  let job = { state: 'idle' };
  const enabled = !!(config.production && config.qaSnapshotUrl && config.qaSnapshotToken);
  return {
    enabled,
    status: () => job,
    start(bearer, by) {
      if (!enabled) throw new Error('Sending a QA copy is only available in production with QA_SNAPSHOT_URL and QA_SNAPSHOT_TOKEN set');
      if (job.state === 'running') return job;
      job = { state: 'running', started_at: new Date().toISOString(), by, step: 'starting' };
      const get = async (path, query = {}) => {
        const u = new URL(config.l27BaseUrl + path);
        for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
        const r = await fetchImpl(u.toString(), { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' } });
        if (!r.ok) throw new Error(`Launch27 ${r.status} for ${path}`);
        return r.json();
      };
      (async () => {
        try {
          const copy = await buildSnapshot(get, { log: (step) => (job.step = step) });
          job.step = 'sending to QA';
          const res = await fetchImpl(`${config.qaSnapshotUrl.replace(/\/$/, '')}/qa/snapshot`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.qaSnapshotToken}` },
            body: JSON.stringify(copy),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(`QA refused the copy (${res.status}): ${body.error || 'unknown error'}`);
          job = { state: 'done', started_at: job.started_at, finished_at: new Date().toISOString(), by, summary: body.summary || summarize(copy) };
          log.info('sent an anonymized copy to QA', job.summary);
        } catch (err) {
          // Messages never contain personal data (the anonymity check reports field paths only).
          job = { state: 'failed', started_at: job.started_at, finished_at: new Date().toISOString(), by, error: err.message };
          log.error('QA copy failed', { error: err.message });
        }
      })();
      return job;
    },
  };
}
