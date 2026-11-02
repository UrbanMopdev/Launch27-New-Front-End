// Customer segments: sync from Launch27, store, and answer the screens' questions.
//
// - Nightly (after 3 am Toronto) the whole customer base is recalculated from bookings and
//   stored: current segment per customer, every change, and the day's counts.
// - The first run also rebuilds the last 12 months (month ends) from booking history, marked
//   as estimated (Launch27 hides cancelled bookings, so those months are close, not exact).
// - A booking made, changed or cancelled in this app recalculates that customer right away.
// All Launch27 calls here are reads.
import { DEFAULT_SEGMENT_SETTINGS, SEGMENTS, SEGMENT_IDS, TRAITS, addDays, byCustomer, classify, daysBetween, monthEnds, slimBooking, suggestion, torontoDate, validateSegmentSettings } from './rules.js';

const HOUR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hourCycle: 'h23' });
const torontoHour = (t) => Number(HOUR.format(new Date(t)));
const SETTINGS_KEY = 'segments';
const NIGHTLY_HOUR = 3;
const OUTCOMES = ['rebooked', 'pause', 'price', 'quality', 'cleaner', 'moved', 'no_answer', 'other', 'snoozed'];
const CHUNK = 500;
// A stored date column -> 'YYYY-MM-DD'. node-postgres returns DATE as a local-midnight Date.
const pad = (n) => String(n).padStart(2, '0');
export const dateStr = (v) => (v == null ? null : typeof v === 'string' ? v.slice(0, 10) : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`);

export function createSegments({ db, config, fetchImpl = fetch, log = { info() {}, warn() {}, error() {} }, now = () => Date.now() }) {
  let running = null;
  let lastRun = undefined; // cached latest run row
  let warnedNoCreds = false;

  const get = async (bearer, path, query = {}) => {
    const u = new URL(config.l27BaseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const res = await fetchImpl(u.toString(), { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Launch27 ${path} returned ${res.status}`);
    return res.json();
  };
  const pullAll = async (bearer, path, query, maxPages = 800) => {
    const out = [];
    for (let page = 0; page < maxPages; page++) {
      const rows = await get(bearer, path, { ...query, limit: 100, offset: page * 100 });
      if (!Array.isArray(rows) || !rows.length) break;
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  };

  // Date ranges are pulled in 90-day slices (keeps each request small; Launch27 lists can
  // cap long ranges), de-duplicated by booking id.
  const pullRange = async (bearer, from, to, query = {}) => {
    const seen = new Map();
    for (let a = from; a <= to; a = addDays(a, 90)) {
      const b = addDays(a, 89) < to ? addDays(a, 89) : to;
      for (const row of await pullAll(bearer, '/v1/staff/bookings', { ...query, from: a, to: b })) seen.set(row.id, row);
    }
    return [...seen.values()];
  };

  async function getSettings(q = db) {
    const row = (await q.query('SELECT value FROM workspace_settings WHERE key = $1', [SETTINGS_KEY])).rows[0];
    return { ...DEFAULT_SEGMENT_SETTINGS, ...(row?.value || {}) };
  }
  async function saveSettings(input) {
    const value = validateSegmentSettings({ ...(await getSettings()), ...input });
    await db.query('INSERT INTO workspace_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [SETTINGS_KEY, JSON.stringify(value)]);
    return value;
  }

  // Background credentials: the synthetic Launch27 in dev/QA, or a dedicated read-only
  // staff login in production (L27_SYNC_EMAIL / L27_SYNC_PASSWORD).
  async function syncBearer() {
    const creds = config.l27Mode === 'mock' ? { email: 'segments-sync@example.com', password: config.mockPassword || 'demo' } : config.l27SyncEmail && config.l27SyncPassword ? { email: config.l27SyncEmail, password: config.l27SyncPassword } : null;
    if (!creds) return null;
    const res = await fetchImpl(`${config.l27BaseUrl}/latest/login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(creds), signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.bearer) throw new Error(`Launch27 login for the segment sync failed (${res.status})`);
    return body.bearer;
  }

  async function latestRun() {
    if (lastRun === undefined) lastRun = (await db.query('SELECT * FROM segment_runs ORDER BY id DESC LIMIT 1')).rows[0] || null;
    return lastRun;
  }
  async function lastSuccess() {
    return (await db.query("SELECT * FROM segment_runs WHERE status = 'done' ORDER BY id DESC LIMIT 1")).rows[0] || null;
  }

  async function upsertRows(q, rows) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await q.query(
        `INSERT INTO customer_segments (customer_id, name, email, phone, city, segment, traits, since, ever_plan, plan, last_clean, next_clean, last_prepaid, first_plan, spend_12m, cleans_12m, computed_at)
         SELECT x.customer_id, x.name, x.email, x.phone, x.city, x.segment, ARRAY(SELECT jsonb_array_elements_text(x.traits)), x.since, x.ever_plan, x.plan, x.last_clean, x.next_clean, x.last_prepaid, x.first_plan, x.spend_12m, x.cleans_12m, now()
         FROM jsonb_to_recordset($1::jsonb) AS x(customer_id bigint, name text, email text, phone text, city text, segment text, traits jsonb, since date, ever_plan boolean, plan text, last_clean date, next_clean date, last_prepaid date, first_plan date, spend_12m numeric, cleans_12m integer)
         ON CONFLICT (customer_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone, city = EXCLUDED.city, segment = EXCLUDED.segment, traits = EXCLUDED.traits,
           since = EXCLUDED.since, ever_plan = EXCLUDED.ever_plan, plan = EXCLUDED.plan, last_clean = EXCLUDED.last_clean, next_clean = EXCLUDED.next_clean, last_prepaid = EXCLUDED.last_prepaid,
           first_plan = EXCLUDED.first_plan, spend_12m = EXCLUDED.spend_12m, cleans_12m = EXCLUDED.cleans_12m, computed_at = now()`,
        [JSON.stringify(rows.slice(i, i + CHUNK))],
      );
    }
  }
  async function insertChanges(q, changes) {
    for (let i = 0; i < changes.length; i += CHUNK) {
      await q.query(
        `INSERT INTO segment_changes (customer_id, from_segment, to_segment, changed_on, estimated)
         SELECT x.customer_id, x.from_segment, x.to_segment, x.changed_on, x.estimated FROM jsonb_to_recordset($1::jsonb) AS x(customer_id bigint, from_segment text, to_segment text, changed_on date, estimated boolean)`,
        [JSON.stringify(changes.slice(i, i + CHUNK))],
      );
    }
  }
  async function writeDaily(q, day, counts, revenue, estimated) {
    for (const seg of SEGMENT_IDS) {
      await q.query(
        'INSERT INTO segment_daily (day, segment, customers, revenue_12m, estimated) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (day, segment) DO UPDATE SET customers = EXCLUDED.customers, revenue_12m = EXCLUDED.revenue_12m, estimated = EXCLUDED.estimated',
        [day, seg, counts[seg] || 0, Math.round((revenue[seg] || 0) * 100) / 100, estimated],
      );
    }
  }

  // The full recalculation.
  async function sync({ bearer, trigger = 'manual' } = {}) {
    const run = (await db.query('INSERT INTO segment_runs (trigger) VALUES ($1) RETURNING *', [trigger])).rows[0];
    lastRun = run;
    const started = Date.now();
    try {
      bearer = bearer || (await syncBearer());
      if (!bearer) throw new Error('No Launch27 login for the segment sync (set L27_SYNC_EMAIL and L27_SYNC_PASSWORD)');
      const settings = await getSettings();
      const today = torontoDate(now());
      const hasHistory = (await db.query('SELECT 1 FROM segment_daily LIMIT 1')).rows.length > 0;
      const from = addDays(today, hasHistory ? -400 : -560);
      const active = await pullRange(bearer, from, addDays(today, 200));
      const cancelledList = await pullRange(bearer, addDays(today, -365), today, { filter: 'cancelled' });
      const groups = byCustomer(active.map(slimBooking));
      const cancels = new Map();
      for (const b of cancelledList) {
        const id = b.user?.id;
        if (id != null) cancels.set(id, (cancels.get(id) || 0) + 1);
      }
      const stored = new Map((await db.query('SELECT * FROM customer_segments')).rows.map((r) => [Number(r.customer_id), r]));

      // First run: rebuild month ends for the past year from booking history.
      const changes = [];
      const baseline = new Map();
      const sinceMap = new Map();
      const backfill = [];
      if (!hasHistory) {
        let prev = null;
        for (const t of monthEnds(today, 12)) {
          const snap = new Map();
          const counts = {};
          const revenue = {};
          for (const [cid, list] of groups) {
            if (!list.some((b) => b.created <= t)) continue;
            const r = classify(list, t, { settings, known: true });
            snap.set(cid, r.segment);
            counts[r.segment] = (counts[r.segment] || 0) + 1;
            revenue[r.segment] = (revenue[r.segment] || 0) + r.spend_12m;
            const before = prev ? prev.get(cid) || 'new' : null;
            if (before === null) sinceMap.set(cid, t);
            else if (before !== r.segment) {
              changes.push({ customer_id: cid, from_segment: before, to_segment: r.segment, changed_on: t, estimated: true });
              sinceMap.set(cid, t);
            }
          }
          backfill.push({ day: t, counts, revenue });
          prev = snap;
        }
        if (prev) for (const [cid, seg] of prev) baseline.set(cid, seg);
      }

      // Today.
      const rows = [];
      const counts = {};
      const revenue = {};
      const ids = new Set([...groups.keys(), ...stored.keys()]);
      for (const cid of ids) {
        const list = groups.get(cid) || [];
        const prevRow = stored.get(cid);
        const r = classify(list, today, { settings, everPlan: !!prevRow?.ever_plan, cancelled: cancels.get(cid) || 0 });
        if (!list.length && prevRow) Object.assign(r, { name: prevRow.name, email: prevRow.email, phone: prevRow.phone, city: prevRow.city, first_plan: prevRow.first_plan, last_clean: dateStr(prevRow.last_clean) });
        const before = prevRow?.segment || baseline.get(cid) || 'new';
        const unchanged = before === r.segment;
        const since = unchanged ? (dateStr(prevRow?.since) || sinceMap.get(cid) || today) : today;
        if (!unchanged) changes.push({ customer_id: cid, from_segment: before, to_segment: r.segment, changed_on: today, estimated: false });
        rows.push({ customer_id: cid, ...r, since });
        counts[r.segment] = (counts[r.segment] || 0) + 1;
        revenue[r.segment] = (revenue[r.segment] || 0) + r.spend_12m;
      }

      await db.tx(async (q) => {
        await upsertRows(q, rows);
        await insertChanges(q, changes);
        for (const b of backfill) await writeDaily(q, b.day, b.counts, b.revenue, true);
        await writeDaily(q, today, counts, revenue, false);
      });
      const done = (await db.query("UPDATE segment_runs SET status = 'done', finished_at = now(), bookings = $2, customers = $3, changes = $4 WHERE id = $1 RETURNING *", [run.id, active.length, rows.length, changes.length])).rows[0];
      lastRun = done;
      log.info('segments updated', { trigger, bookings: active.length, customers: rows.length, changes: changes.length, backfilled: backfill.length, ms: Date.now() - started });
      return done;
    } catch (err) {
      lastRun = (await db.query("UPDATE segment_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 RETURNING *", [run.id, String(err.message).slice(0, 500)])).rows[0];
      log.error('segment sync failed', { trigger, error: err.message });
      throw err;
    }
  }

  // Start a sync in the background (one at a time).
  function start(opts) {
    if (!running) running = sync(opts).catch(() => null).finally(() => (running = null));
    return running;
  }

  // Called by the worker: first run on boot, then once a day after 3 am Toronto.
  async function maybeRun() {
    if (running) return;
    const last = await latestRun();
    const t = now();
    if (last?.status === 'failed' && t - new Date(last.started_at).getTime() < 60 * 60_000) return; // retry hourly
    const ok = last?.status === 'done' ? last : await lastSuccess();
    const due = !ok || (torontoHour(t) >= NIGHTLY_HOUR && torontoDate(ok.started_at) < torontoDate(t));
    if (!due) return;
    if (config.l27Mode !== 'mock' && !(config.l27SyncEmail && config.l27SyncPassword)) {
      if (!warnedNoCreds) log.warn('segments: no nightly update until L27_SYNC_EMAIL and L27_SYNC_PASSWORD are set (admins can still use "Update now")');
      warnedNoCreds = true;
      return;
    }
    start({ trigger: ok ? 'nightly' : 'boot' });
  }

  // One customer, right after a booking change made in this app.
  async function refreshCustomer(bearer, customerId) {
    const cid = Number(customerId);
    if (!Number.isFinite(cid)) return null;
    const settings = await getSettings();
    const today = torontoDate(now());
    const list = await pullRange(bearer, addDays(today, -400), addDays(today, 200), { customers: cid });
    const cancelled = await get(bearer, '/v1/staff/bookings/count', { customers: cid, filter: 'cancelled', from: addDays(today, -365), to: today }).catch(() => ({ count: 0 }));
    const prev = (await db.query('SELECT * FROM customer_segments WHERE customer_id = $1', [cid])).rows[0];
    const slim = list.map(slimBooking).filter((b) => b.customer_id == null || Number(b.customer_id) === cid);
    const r = classify(slim, today, { settings, everPlan: !!prev?.ever_plan, cancelled: Number(cancelled?.count) || 0 });
    if (!slim.length && prev) Object.assign(r, { name: prev.name, email: prev.email, phone: prev.phone, city: prev.city });
    const before = prev?.segment || 'new';
    const since = before === r.segment && prev?.since ? dateStr(prev.since) : today;
    await db.tx(async (q) => {
      await upsertRows(q, [{ customer_id: cid, ...r, since }]);
      if (before !== r.segment) await insertChanges(q, [{ customer_id: cid, from_segment: before, to_segment: r.segment, changed_on: today, estimated: false }]);
    });
    return { ...r, since };
  }

  // ---------- reads for the screens ----------

  function nextRunAt(t = now()) {
    // Next 3 am Toronto (approximate: the worker checks every few seconds after that hour).
    for (let h = 0; h < 48; h++) {
      const c = t + h * 3600_000;
      if (torontoHour(c) === NIGHTLY_HOUR && c > t) return new Date(c - (new Date(c).getMinutes() * 60_000)).toISOString();
    }
    return null;
  }

  async function summary({ bearer } = {}) {
    const counts = (await db.query('SELECT segment, count(*)::int AS n, coalesce(sum(spend_12m),0)::float AS revenue FROM customer_segments GROUP BY segment')).rows;
    const traits = (await db.query('SELECT t AS trait, count(*)::int AS n FROM customer_segments, unnest(traits) AS t GROUP BY t')).rows;
    const total = counts.reduce((s, r) => s + r.n, 0);
    const revenue = counts.reduce((s, r) => s + r.revenue, 0);
    let launch27Customers = null;
    if (bearer) launch27Customers = await get(bearer, '/v1/staff/customers/count', {}).then((r) => Number(r?.count) || null).catch(() => null);
    const ok = await lastSuccess();
    const last = await latestRun();
    return {
      segments: SEGMENTS.map((s) => {
        const row = counts.find((r) => r.segment === s.id);
        return { ...s, count: row?.n || 0, revenue_12m: row?.revenue || 0, revenue_share: revenue ? (row?.revenue || 0) / revenue : 0 };
      }),
      traits: TRAITS.map((t) => ({ ...t, count: traits.find((r) => r.trait === t.id)?.n || 0 })),
      total,
      no_recent: launch27Customers && launch27Customers > total ? launch27Customers - total : null,
      updated_at: ok?.finished_at || null,
      running: !!running || last?.status === 'running',
      last_error: last?.status === 'failed' ? last.error : null,
      next_run_at: nextRunAt(),
      settings: await getSettings(),
    };
  }

  async function customers({ segment, traits = [], q, limit = 50, offset = 0 } = {}) {
    const settings = await getSettings();
    const today = torontoDate(now());
    const params = [];
    const where = [];
    if (segment) {
      params.push(segment);
      where.push(`s.segment = $${params.length}`);
    }
    if (traits.length) {
      params.push(traits);
      where.push(`s.traits @> $${params.length}::text[]`);
    }
    if (q) {
      params.push(`%${String(q).toLowerCase()}%`);
      const conds = [`lower(coalesce(s.name,'')) LIKE $${params.length}`, `lower(coalesce(s.email,'')) LIKE $${params.length}`];
      const digits = String(q).replace(/\D/g, '');
      if (digits.length >= 3) {
        params.push(`%${digits}%`);
        conds.push(`regexp_replace(coalesce(s.phone,''), '[^0-9]', '', 'g') LIKE $${params.length}`);
      }
      where.push(`(${conds.join(' OR ')})`);
    }
    const order = segment === 'risk' ? 's.last_clean ASC NULLS LAST' : segment === 'first' || segment === 'recurring' || segment === 'repeat' ? 's.next_clean ASC NULLS LAST, s.last_clean DESC NULLS LAST' : 's.spend_12m DESC';
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await db.query(`SELECT count(*)::int AS n FROM customer_segments s ${w}`, params)).rows[0].n;
    params.push(Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0));
    const rows = (await db.query(
      `SELECT s.*, o.outcome AS last_outcome, o.created_at AS last_outcome_at, o.snoozed_until
       FROM customer_segments s
       LEFT JOIN LATERAL (SELECT outcome, created_at, snoozed_until FROM segment_outcomes WHERE customer_id = s.customer_id ORDER BY created_at DESC LIMIT 1) o ON true
       ${w}
       ORDER BY (o.snoozed_until IS NOT NULL AND o.snoozed_until > CURRENT_DATE), ${order}, s.customer_id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )).rows;
    return { total, rows: rows.map((r) => present(r, today, settings)) };
  }

  const d = dateStr;
  function present(r, today, settings) {
    const row = { customer_id: Number(r.customer_id), name: r.name, email: r.email, phone: r.phone, city: r.city, segment: r.segment, traits: r.traits || [], since: d(r.since), plan: r.plan, last_clean: d(r.last_clean), next_clean: d(r.next_clean), last_prepaid: d(r.last_prepaid), spend_12m: Number(r.spend_12m) || 0, cleans_12m: r.cleans_12m };
    const s = suggestion(row, today, settings);
    return {
      ...row,
      suggestion: s.text,
      days_left: s.days_left ?? null,
      days_since_last: row.last_clean ? daysBetween(row.last_clean, today) : null,
      last_outcome: r.last_outcome || null,
      last_outcome_at: r.last_outcome_at || null,
      snoozed_until: d(r.snoozed_until),
    };
  }

  async function customer(cid) {
    const r = (await db.query('SELECT * FROM customer_segments WHERE customer_id = $1', [cid])).rows[0];
    if (!r) return null;
    const settings = await getSettings();
    const history = (await db.query('SELECT from_segment, to_segment, changed_on, estimated FROM segment_changes WHERE customer_id = $1 ORDER BY changed_on, id', [cid])).rows.map((c) => ({ ...c, changed_on: d(c.changed_on) }));
    const outcomes = (await db.query('SELECT o.outcome, o.note, o.segment, o.snoozed_until, o.created_at, u.name AS by FROM segment_outcomes o LEFT JOIN users u ON u.id = o.user_id WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 10', [cid])).rows;
    return { ...present(r, torontoDate(now()), settings), history, outcomes };
  }

  async function logOutcome(cid, { outcome, note, snooze_days }, userId) {
    if (!OUTCOMES.includes(outcome)) throw Object.assign(new Error(`outcome must be one of ${OUTCOMES.join(', ')}`), { status: 400 });
    const r = (await db.query('SELECT segment FROM customer_segments WHERE customer_id = $1', [cid])).rows[0];
    if (!r) throw Object.assign(new Error('Customer has no segment yet'), { status: 404 });
    const until = outcome === 'snoozed' ? addDays(torontoDate(now()), Math.min(Math.max(Number(snooze_days) || 7, 1), 60)) : null;
    await db.query('INSERT INTO segment_outcomes (customer_id, segment, outcome, note, snoozed_until, user_id) VALUES ($1,$2,$3,$4,$5,$6)', [cid, r.segment, outcome, note ? String(note).slice(0, 1000) : null, until, userId || null]);
  }

  // Numbers for one segment's work list (At risk and friends).
  async function segmentStats(segment) {
    const settings = await getSettings();
    const today = torontoDate(now());
    const monthStart = `${today.slice(0, 8)}01`;
    const base = (await db.query(
      `SELECT count(*)::int AS n, coalesce(sum(spend_12m),0)::float AS revenue,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM segment_outcomes o WHERE o.customer_id = s.customer_id AND o.created_at >= s.since))::int AS not_contacted,
        count(*) FILTER (WHERE s.last_clean IS NOT NULL AND s.last_clean <= $2::date)::int AS lapsing_this_week
       FROM customer_segments s WHERE segment = $1`,
      [segment, addDays(today, -(settings.risk_days - 7))],
    )).rows[0];
    const saved = (await db.query("SELECT count(*)::int AS n FROM segment_changes WHERE from_segment = $1 AND to_segment = 'recurring' AND changed_on >= $2", [segment, monthStart])).rows[0].n;
    const reason = (await db.query("SELECT outcome, count(*)::int AS n FROM segment_outcomes WHERE segment = $1 AND outcome NOT IN ('snoozed','rebooked','no_answer') AND created_at > now() - interval '90 days' GROUP BY outcome ORDER BY n DESC LIMIT 1", [segment])).rows[0];
    return { customers: base.n, revenue_12m: base.revenue, not_contacted: base.not_contacted, lapsing_this_week: segment === 'risk' ? base.lapsing_this_week : null, saved_this_month: saved, top_reason: reason?.outcome || null };
  }

  async function trends({ period = '12m', from, to } = {}) {
    const today = torontoDate(now());
    const days = { '30d': 30, '90d': 90, '12m': 365 }[period];
    const start = period === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : addDays(today, -(days || 365));
    const end = period === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : today;
    const daily = (await db.query('SELECT day, segment, customers, estimated FROM segment_daily WHERE day <= $1 ORDER BY day', [end])).rows.map((r) => ({ ...r, day: d(r.day) }));
    // Series: every stored day in range, plus the nearest one before it as the starting point.
    const dayList = [...new Set(daily.map((r) => r.day))];
    const before = dayList.filter((x) => x <= start).at(-1) || dayList[0] || null;
    const shown = dayList.filter((x) => x >= (before || start));
    const series = shown.map((day) => {
      const rows = daily.filter((r) => r.day === day);
      return { day, estimated: rows.some((r) => r.estimated), ...Object.fromEntries(SEGMENT_IDS.map((s) => [s, rows.find((r) => r.segment === s)?.customers || 0])) };
    });
    const sinceDay = before && before < start ? before : start;
    const moves = (await db.query('SELECT from_segment, to_segment, count(*)::int AS n FROM segment_changes WHERE changed_on > $1 AND changed_on <= $2 GROUP BY 1,2 ORDER BY n DESC', [sinceDay, end])).rows;
    const m = (f, t) => moves.filter((x) => (f === '*' || x.from_segment === f) && x.to_segment === t).reduce((s, x) => s + x.n, 0);
    const startRecurring = series[0]?.recurring ?? 0;
    const endRecurring = series.at(-1)?.recurring ?? 0;
    const gains = { new: m('new', 'recurring'), converted: m('first', 'recurring') + m('repeat', 'recurring') + m('lapsedOne', 'recurring'), won_back: m('lapsedRec', 'recurring') };
    const joined = gains.new + gains.converted + gains.won_back;
    const toRisk = m('recurring', 'risk');
    const saved = m('risk', 'recurring');
    const firsts = (await db.query(
      `SELECT s.segment, count(*)::int AS n FROM segment_changes c JOIN customer_segments s ON s.customer_id = c.customer_id
       WHERE c.from_segment = 'new' AND c.to_segment = 'first' AND c.changed_on > $1 AND c.changed_on <= $2 GROUP BY s.segment`,
      [sinceDay, end],
    )).rows;
    const fc = (ids) => firsts.filter((r) => ids.includes(r.segment)).reduce((s, r) => s + r.n, 0);
    return {
      period, from: start, to: end, since_day: sinceDay,
      series,
      estimated_until: daily.filter((r) => r.estimated).at(-1)?.day || null,
      moves,
      flow: { start: startRecurring, ...gains, left: Math.max(startRecurring + joined - endRecurring, 0), end: endRecurring },
      kpis: { recurring: endRecurring, recurring_change: endRecurring - startRecurring, joined, to_risk: toRisk, saved, save_rate: toRisk ? saved / toRisk : null },
      first_timers: { total: fc(SEGMENT_IDS), lapsed: fc(['lapsedOne']), still: fc(['first']), repeat: fc(['repeat']), plan: fc(['recurring', 'risk', 'lapsedRec']) },
    };
  }

  return { sync, start, maybeRun, refreshCustomer, summary, customers, customer, logOutcome, segmentStats, trends, getSettings, saveSettings, isRunning: () => !!running, OUTCOMES };
}
