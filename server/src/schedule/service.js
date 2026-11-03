// Scheduling planner: sync from Launch27 (read-only), detect changes, answer the screens.
// Writes (assigning a cleaner) go to Launch27 with the signed-in user's own login.
import { SAMPLE_VERSION } from '../mock/launch27.js';
import {
  FREQ_LABEL, STATUS_LABEL, addDays, areaOf, customerPrefs, cycleWeek, cycleWeeks, daysBetween, fitsDay, frequencyKind,
  isPrepaid, km, nameMatches, localDate, localMinutes, mainCleaner, mondayOf, openGaps, parseCleaner, rankCleaners, seriesDates,
  weekday, weeklyHours, workingWindow, toMinutes as toMinutesHM, travelMinutes,
} from './rules.js';

const PAST_DAYS = 91;
const AHEAD_DAYS = 56;
const NEAR_DAYS = 14; // problems are raised for this many days ahead
const NEAR_EVERY_MS = 3 * 60_000; // next 14 days of bookings
const FULL_EVERY_MS = 60 * 60_000; // cleaners' hours and status, the whole window
const CHANGE_DELAY_MS = 20_000; // after a booking change made in this app
const PROBLEM_KINDS = ['unassigned', 'outside_hours', 'double_booked', 'different_cleaner', 'cleaner_unavailable'];
const DAYNAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (v) => (v == null ? null : typeof v === 'string' ? v.slice(0, 10) : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`);
const nice = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const clock = (min) => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 || 12}${m ? `:${pad(m)}` : ''}${h >= 12 ? 'pm' : 'am'}`;
};

// Launch27 booking -> the fields the planner needs.
export function slimVisit(b) {
  const u = b.user || {};
  const key = b.id ? String(b.id) : `f${b.forecasted_from_booking?.id || 'x'}-${String(b.service_date).slice(0, 10)}`;
  const start = localMinutes(b.service_date);
  const duration = Number(b.duration) || Math.round((b.teams?.[0]?.hours || 3) * 60);
  const kind = frequencyKind(b.frequency?.name);
  const date = localDate(b.service_date);
  return {
    key,
    id: b.id || null,
    series_id: b.forecasted_from_booking?.id || null,
    date,
    start,
    duration,
    end: start + duration,
    customer_id: u.id ?? null,
    customer: u.name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.company_name || 'Customer',
    phone: b.phone || null,
    lat: b.address?.latitude ?? null,
    lng: b.address?.longitude ?? null,
    area: b.address?.city || null,
    freq: b.frequency?.name || null,
    kind,
    prepaid: isPrepaid(b.frequency?.name),
    weeks: cycleWeeks(kind, date),
    services: (b.services || []).map((s) => s.name).filter(Boolean),
    team_ids: (b.teams || []).map((t) => Number(t.id)),
    team_hours: Object.fromEntries((b.teams || []).map((t) => [t.id, t.hours || 0])),
    tags: (u.tags_info || []).map((t) => t.name).filter(Boolean),
  };
}

// dataTag (dev/QA): names the data underneath (sample version or QA copy) so a switch is noticed.
export function createSchedule({ db, config, fetchImpl = fetch, log = { info() {}, warn() {}, error() {} }, now = () => Date.now(), dataTag = () => SAMPLE_VERSION, writes = null }) {
  let snap = null; // latest snapshot (in memory)
  let unavailable = new Map(); // cleanerId -> Set(dates)
  let running = null;
  let lastRun;
  let warnedNoCreds = false;

  const today = () => localDate(now());
  const get = async (bearer, path, query = {}) => {
    const u = new URL(config.l27BaseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const res = await fetchImpl(u.toString(), { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Launch27 ${path} returned ${res.status}`);
    return res.json();
  };
  const pullAll = async (bearer, path, query, maxPages = 400) => {
    const out = [];
    for (let page = 0; page < maxPages; page++) {
      const rows = await get(bearer, path, { ...query, limit: 100, offset: page * 100 });
      if (!Array.isArray(rows) || !rows.length) break;
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  };
  const pullRange = async (bearer, from, to) => {
    const seen = new Map();
    for (let a = from; a <= to; a = addDays(a, 30)) {
      const b = addDays(a, 29) < to ? addDays(a, 29) : to;
      for (const row of await pullAll(bearer, '/v1/staff/bookings', { from: a, to: b })) {
        const v = slimVisit(row);
        seen.set(v.key, v);
      }
    }
    return [...seen.values()];
  };
  async function syncBearer() {
    const creds = config.l27Mode === 'mock' ? { email: 'schedule-sync@example.com', password: config.mockPassword || 'demo' } : config.l27SyncEmail && config.l27SyncPassword ? { email: config.l27SyncEmail, password: config.l27SyncPassword } : null;
    if (!creds) return null;
    const res = await fetchImpl(`${config.l27BaseUrl}/latest/login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(creds), signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.bearer) throw new Error(`Launch27 login for the schedule sync failed (${res.status})`);
    return body.bearer;
  }

  async function loadUnavailable() {
    const rows = (await db.query('SELECT cleaner_id, day FROM schedule_unavailable WHERE day >= $1', [addDays(today(), -1)])).rows;
    unavailable = new Map();
    for (const r of rows) {
      const id = Number(r.cleaner_id);
      if (!unavailable.has(id)) unavailable.set(id, new Set());
      unavailable.get(id).add(dateStr(r.day));
    }
  }
  async function load() {
    if (snap) return snap;
    const row = (await db.query('SELECT data FROM schedule_snapshots ORDER BY id DESC LIMIT 1')).rows[0];
    snap = row ? index(row.data) : null;
    await loadUnavailable();
    return snap;
  }

  // ---------- derived indexes over a snapshot ----------
  function index(data) {
    const cleaners = data.cleaners;
    const byId = new Map(cleaners.map((c) => [c.id, c]));
    const t = data.today;
    const future = data.visits.filter((v) => v.date >= t);
    const past = data.visits.filter((v) => v.date < t);
    const busy = new Map(); // `${id}|${date}` -> visits
    for (const v of data.visits) {
      for (const id of v.team_ids) {
        const k = `${id}|${v.date}`;
        if (!busy.has(k)) busy.set(k, []);
        busy.get(k).push(v);
      }
    }
    // Customers: main cleaner, history, prefs.
    const customers = new Map();
    for (const v of data.visits) {
      if (v.customer_id == null) continue;
      if (!customers.has(v.customer_id)) customers.set(v.customer_id, { id: v.customer_id, name: v.customer, past: [], future: [], tags: v.tags, phone: v.phone });
      const c = customers.get(v.customer_id);
      (v.date < t ? c.past : c.future).push(v);
      if (v.tags?.length) c.tags = v.tags;
      if (v.phone) c.phone = v.phone;
    }
    for (const c of customers.values()) {
      const recurring = [...c.past, ...c.future].some((v) => v.kind !== 'one');
      c.recurring = recurring;
      c.main = mainCleaner(c.past.filter((v) => v.kind !== 'one')) || mainCleaner(c.past) || (recurring ? mainCleaner(c.future) : null);
      c.history = new Map();
      for (const v of c.past) for (const id of v.team_ids) c.history.set(id, (c.history.get(id) || 0) + 1);
      c.prefs = customerPrefs(c.tags || []);
    }
    return { ...data, byId, future, past, busy, customers };
  }

  const windowFor = (c, d) => workingWindow(c.availability, d, unavailable.get(c.id));
  const busyFor = (s) => (id, d) => (s.busy.get(`${id}|${d}`) || []).map((v) => ({ start: v.start, end: v.end, lat: v.lat, lng: v.lng, key: v.key }));
  function bookedHours(s, id, from, to) {
    let min = 0;
    for (const v of s.visits) if (v.date >= from && v.date <= to && v.team_ids.includes(id)) min += v.team_hours?.[id] ? v.team_hours[id] * 60 : v.duration / Math.max(v.team_ids.length, 1);
    return min / 60;
  }
  function capacityHours(c, from, to) {
    let min = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const w = windowFor(c, d);
      if (w) min += w[1] - w[0];
    }
    return min / 60;
  }
  const ctxFor = (s) => ({
    today: s.today,
    windowFor,
    busyFor: busyFor(s),
    weekLoad: (id, d) => {
      const c = s.byId.get(id);
      const from = mondayOf(d);
      return { booked: bookedHours(s, id, from, addDays(from, 6)), capacity: c ? capacityHours(c, from, addDays(from, 6)) : 0 };
    },
  });

  // ---------- problems & changes ----------
  // Visits without a cleaner, grouped into series (client + rhythm + weekday + time).
  function unassignedSeries(s) {
    const groups = new Map();
    for (const v of s.future.filter((x) => !x.team_ids.length)) {
      const k = `${v.customer_id}|${v.kind}|${weekday(v.date)}|${v.start}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v);
    }
    for (const list of groups.values()) list.sort((a, b) => a.date.localeCompare(b.date));
    return groups;
  }
  const seriesWhen = (v) => `${DAYNAME[weekday(v.date)]} ${clock(v.start)}${v.kind === 'bi' ? ` · weeks ${v.weeks.split('').join('/')}` : v.kind === 'monthly' ? ` · week ${v.weeks}` : ''}`;

  function problems(s) {
    const out = [];
    for (const [k, list] of unassignedSeries(s)) {
      const v = list[0];
      out.push({ due: v.date, visit_key: v.key, customer_id: v.customer_id, kind: 'unassigned', key: `unassigned:${k}`, title: `No cleaner: ${v.customer} · ${seriesWhen(v)} · ${list.length} visit${list.length === 1 ? '' : 's'}`, detail: { series: k, freq: FREQ_LABEL[v.kind] } });
    }
    const until = addDays(s.today, NEAR_DAYS);
    for (const v of s.future) {
      if (v.date > until) continue;
      const cust = s.customers.get(v.customer_id);
      const base = { due: v.date, visit_key: v.key, customer_id: v.customer_id };
      const when = `${nice(v.date)} ${clock(v.start)}`;
      if (!v.team_ids.length) continue; // whole series, all 8 weeks: added below
      for (const id of v.team_ids) {
        const c = s.byId.get(id);
        if (!c) continue;
        if (!c.assignable || unavailable.get(id)?.has(v.date)) {
          out.push({ ...base, cleaner_id: id, kind: 'cleaner_unavailable', key: `cleaner_unavailable:${v.key}:${id}`, title: `${c.name} can't take ${v.customer} · ${when}`, detail: { why: unavailable.get(id)?.has(v.date) ? 'marked unavailable that day' : STATUS_LABEL[c.status].toLowerCase() } });
          continue;
        }
        const w = windowFor(c, v.date);
        if (!w || v.start < w[0] || v.end > w[1]) {
          out.push({ ...base, cleaner_id: id, kind: 'outside_hours', key: `outside_hours:${v.key}:${id}`, title: `Outside ${c.name}'s hours: ${v.customer} · ${when}`, detail: { hours: w ? `${clock(w[0])}–${clock(w[1])}` : 'not working that day' } });
        }
        const same = (s.busy.get(`${id}|${v.date}`) || []).filter((o) => o.key !== v.key && o.start < v.end && v.start < o.end);
        if (same.length && same.every((o) => o.key > v.key)) {
          out.push({ ...base, cleaner_id: id, kind: 'double_booked', key: `double_booked:${v.key}:${id}`, title: `${c.name} is double-booked · ${when}`, detail: { with: same.map((o) => o.customer) } });
        }
      }
      if (cust?.main && v.kind !== 'one' && !v.team_ids.includes(cust.main.id)) {
        // Only when the usual cleaner could take it back: that is the one dispatch can act on.
        const main = s.byId.get(cust.main.id);
        const allowed = main && !cust.prefs.avoid.some((n) => nameMatches(main.name, n)) && !(cust.prefs.femaleOnly && main.gender !== 'F');
        const free = allowed && main?.assignable && fitsDay({ window: windowFor(main, v.date), busy: busyFor(s)(main.id, v.date), start: v.start, duration: v.duration, place: v, transit: main.rules.transit, ignoreKeys: new Set([v.key]) }).ok;
        if (main && free) out.push({ ...base, cleaner_id: cust.main.id, kind: 'different_cleaner', key: `different_cleaner:${v.key}:${v.team_ids.join('-')}`, title: `${main.name} is free to take back ${v.customer} · ${when}`, detail: { main: main.name, booked: v.team_ids.map((id) => s.byId.get(id)?.name || 'Unknown') } });
      }
    }
    return out;
  }

  // Compare two snapshots: what moved, what got cancelled, whose availability changed.
  function diff(prev, next) {
    const out = [];
    const t = next.today;
    const until = addDays(t, AHEAD_DAYS);
    const before = new Map(prev.visits.filter((v) => v.id && v.date >= t).map((v) => [v.key, v]));
    const after = new Map(next.visits.filter((v) => v.id && v.date >= t).map((v) => [v.key, v]));
    const name = (_, id) => next.byId.get(id)?.name || prev.byId?.get(id)?.name || 'Unknown';
    for (const [k, a] of after) {
      const b = before.get(k);
      if (!b) continue;
      if (a.date !== b.date || a.start !== b.start) {
        out.push({ kind: 'moved', key: `moved:${k}:${a.date}:${a.start}`, due: a.date, visit_key: k, customer_id: a.customer_id, cleaner_id: a.team_ids[0] || null, title: `${a.customer} moved from ${nice(b.date)} ${clock(b.start)} to ${nice(a.date)} ${clock(a.start)}`, detail: { from: { date: b.date, start: b.start }, to: { date: a.date, start: a.start } } });
      }
      const was = b.team_ids.join(',');
      const is = a.team_ids.join(',');
      if (was !== is && b.team_ids.length) {
        out.push({ kind: 'cleaner_changed', key: `cleaner_changed:${k}:${is || 'none'}`, due: a.date, visit_key: k, customer_id: a.customer_id, cleaner_id: b.team_ids[0], title: `${a.customer} · ${nice(a.date)}: ${b.team_ids.map((id) => name(next, id)).join(' & ')} → ${a.team_ids.length ? a.team_ids.map((id) => name(next, id)).join(' & ') : 'no cleaner'}`, detail: { from: b.team_ids, to: a.team_ids } });
      }
    }
    for (const [k, b] of before) {
      if (after.has(k) || b.date > until) continue;
      if (next.visits.some((v) => v.key === k)) continue;
      const who = b.team_ids.map((id) => name(next, id)).join(' & ');
      out.push({ kind: 'cancelled', key: `cancelled:${k}`, due: b.date, visit_key: k, customer_id: b.customer_id, cleaner_id: b.team_ids[0] || null, title: `Cancelled: ${b.customer} · ${nice(b.date)} ${clock(b.start)}${who ? `, ${who} has ${Math.round(b.duration / 6) / 10}h free` : ''}`, detail: { date: b.date, start: b.start, duration: b.duration } });
    }
    for (const c of next.cleaners) {
      const old = prev.byId?.get(c.id);
      if (!old) continue;
      const sig = (x) => JSON.stringify((x.availability || []).map((r) => [r.date, r.weekday, r.dayoff, r.start_time, r.end_time]).sort());
      const statusChanged = old.assignable !== c.assignable;
      if (sig(old) === sig(c) && !statusChanged) continue;
      const affected = next.future.filter((v) => v.team_ids.includes(c.id)).filter((v) => {
        const w = windowFor(c, v.date);
        return !c.assignable || !w || v.start < w[0] || v.end > w[1];
      });
      out.push({ kind: 'availability', key: `availability:${c.id}:${sig(c).length}:${c.status}`, due: affected[0]?.date || t, cleaner_id: c.id, title: statusChanged ? `${c.name} is now ${STATUS_LABEL[c.status].toLowerCase()}: ${affected.length} upcoming visit${affected.length === 1 ? '' : 's'} affected` : `${c.name}'s hours changed: ${affected.length} upcoming visit${affected.length === 1 ? '' : 's'} no longer fit`, detail: { affected: affected.slice(0, 20).map((v) => v.key) } });
    }
    return out;
  }

  async function recordChanges(q, found) {
    // Open problems that are no longer true resolve themselves; past items too.
    const keys = new Set(found.map((f) => f.key));
    const open = (await q.query('SELECT id, key, kind, due FROM schedule_changes WHERE resolved_at IS NULL')).rows;
    for (const r of open) {
      const due = dateStr(r.due);
      if (due && due < today()) await q.query("UPDATE schedule_changes SET resolved_at = now(), resolution = 'past' WHERE id = $1", [r.id]);
      else if (PROBLEM_KINDS.includes(r.kind) && !keys.has(r.key)) await q.query("UPDATE schedule_changes SET resolved_at = now(), resolution = 'gone' WHERE id = $1", [r.id]);
    }
    let added = 0;
    for (const f of found) {
      const res = await q.query(
        `INSERT INTO schedule_changes (key, kind, due, visit_key, customer_id, cleaner_id, title, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (key) WHERE resolved_at IS NULL DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail, due = EXCLUDED.due RETURNING (xmax = 0) AS inserted`,
        [f.key, f.kind, f.due || null, f.visit_key || null, f.customer_id ?? null, f.cleaner_id ?? null, f.title, JSON.stringify(f.detail || {})],
      );
      if (res.rows[0]?.inserted) added++;
    }
    return added;
  }

  // ---------- sync ----------
  // Two kinds of refresh, both read-only:
  //  - full (hourly): cleaners, their hours and status, 13 weeks back and 8 weeks ahead
  //  - near (every few minutes): just the next 14 days of bookings, merged into the last full
  //    copy. A booking that vanished from those 14 days is looked up on its own, so a visit moved
  //    further out reads as moved, not cancelled.
  let cachedBearer = null; // { bearer, at }
  async function bearerFor(given) {
    if (given) return given;
    if (cachedBearer && now() - cachedBearer.at < 30 * 60_000) return cachedBearer.bearer;
    const b = await syncBearer();
    if (b) cachedBearer = { bearer: b, at: now() };
    return b;
  }

  async function fullData(bearer, t) {
    const teams = (await pullAll(bearer, '/v1/staff/teams', {}, 40)).filter((x) => x.active !== false);
    const cleaners = [];
    for (const tm of teams) {
      const c = parseCleaner(tm);
      c.availability = await get(bearer, `/v1/staff/teams/${tm.id}/availability`).catch(() => []);
      c.weekly_hours = weeklyHours(c.availability);
      c.area = areaOf(c);
      c.share = tm.share || null;
      cleaners.push(c);
    }
    const visits = await pullRange(bearer, addDays(t, -PAST_DAYS), addDays(t, AHEAD_DAYS));
    const iso = new Date(now()).toISOString();
    return { taken_at: iso, full_at: iso, today: t, cycle_anchor: '2026-11-02', cleaners, visits };
  }

  async function nearData(bearer, prev, t) {
    const until = addDays(t, NEAR_DAYS);
    const fresh = await pullRange(bearer, t, until);
    const freshKeys = new Set(fresh.map((v) => v.key));
    const extra = [];
    const gone = new Set();
    for (const v of prev.visits) {
      if (!v.id || v.date < t || v.date > until || freshKeys.has(v.key)) continue;
      try {
        const b = await get(bearer, `/v1/staff/bookings/${v.id}`);
        if (b && b.active !== false && b.service_date) extra.push(slimVisit(b));
        else gone.add(v.key);
      } catch {
        gone.add(v.key);
      }
    }
    const replaced = new Set([...freshKeys, ...extra.map((v) => v.key), ...gone]);
    const kept = prev.visits.filter((v) => !(v.date >= t && v.date <= until) && !replaced.has(v.key));
    return { taken_at: new Date(now()).toISOString(), full_at: prev.full_at || prev.taken_at, today: t, cycle_anchor: prev.cycle_anchor, cleaners: prev.cleaners, visits: [...kept, ...fresh, ...extra] };
  }

  async function sync({ bearer, trigger = 'manual', kind = 'full' } = {}) {
    const run = (await db.query('INSERT INTO schedule_runs (trigger) VALUES ($1) RETURNING *', [`${trigger}:${kind}`])).rows[0];
    lastRun = run;
    try {
      bearer = await bearerFor(bearer);
      if (!bearer) throw new Error('No Launch27 login for the schedule sync (set L27_SYNC_EMAIL and L27_SYNC_PASSWORD)');
      const t = today();
      const loaded = await load();
      // Sample data (dev/QA only) was regenerated: start over rather than diffing against it.
      const sample = config.l27Mode === 'mock' ? dataTag() : undefined;
      const restart = config.l27Mode === 'mock' && loaded && loaded.sample !== sample;
      const prev = restart ? null : loaded;
      const doNear = kind === 'near' && prev && prev.today === t;
      const data = { ...(doNear ? await nearData(bearer, prev, t) : await fullData(bearer, t)), sample };
      await loadUnavailable();
      const next = index(data);
      const found = [...(prev ? diff(prev, next) : []), ...problems(next)];
      let added = 0;
      await db.tx(async (q) => {
        if (restart) await q.query("UPDATE schedule_changes SET resolved_at = now(), resolution = 'gone' WHERE resolved_at IS NULL");
        await q.query('INSERT INTO schedule_snapshots (data) VALUES ($1::jsonb)', [JSON.stringify(data)]);
        await q.query('DELETE FROM schedule_snapshots WHERE id NOT IN (SELECT id FROM schedule_snapshots ORDER BY id DESC LIMIT 2)');
        added = await recordChanges(q, found);
      });
      snap = next;
      lastRun = (await db.query("UPDATE schedule_runs SET status = 'done', finished_at = now(), visits = $2, cleaners = $3, changes = $4 WHERE id = $1 RETURNING *", [run.id, data.visits.length, data.cleaners.length, added])).rows[0];
      log.info('schedule updated', { trigger, kind: doNear ? 'near' : 'full', visits: data.visits.length, cleaners: data.cleaners.length, changes: added });
      return lastRun;
    } catch (err) {
      if (/returned 401/.test(err.message)) cachedBearer = null;
      lastRun = (await db.query("UPDATE schedule_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 RETURNING *", [run.id, String(err.message).slice(0, 500)])).rows[0];
      log.error('schedule sync failed', { trigger, error: err.message });
      throw err;
    }
  }
  function start(opts) {
    if (!running) running = sync(opts).catch(() => null).finally(() => (running = null));
    return running;
  }
  // A booking changed in this app: quick refresh shortly after (one for a burst of edits).
  let soonTimer = null;
  function soon(bearer) {
    if (soonTimer) return;
    soonTimer = setTimeout(() => {
      soonTimer = null;
      if (running) running.then(() => start({ bearer, trigger: 'change', kind: 'near' }));
      else start({ bearer, trigger: 'change', kind: 'near' });
    }, CHANGE_DELAY_MS);
    soonTimer.unref?.();
  }
  async function latestRun() {
    if (lastRun === undefined) lastRun = (await db.query('SELECT * FROM schedule_runs ORDER BY id DESC LIMIT 1')).rows[0] || null;
    return lastRun;
  }
  // Called by the background worker, and (with the viewer's own Launch27 login) whenever
  // someone has the planner open, so it stays fresh even without a dedicated sync login.
  // Only reads from Launch27.
  async function maybeRun({ bearer = null } = {}) {
    if (running) return;
    const last = await latestRun();
    const t = now();
    if (last?.status === 'failed' && t - new Date(last.started_at).getTime() < 10 * 60_000) return;
    if (!bearer && config.l27Mode !== 'mock' && !(config.l27SyncEmail && config.l27SyncPassword)) {
      if (!warnedNoCreds) log.warn('schedule: no background refresh until L27_SYNC_EMAIL and L27_SYNC_PASSWORD are set; it refreshes while someone has the planner open');
      warnedNoCreds = true;
      return;
    }
    const s = await load();
    const fullAge = s ? t - new Date(s.full_at || s.taken_at).getTime() : Infinity;
    const anyAge = s ? t - new Date(s.taken_at).getTime() : Infinity;
    const trigger = bearer ? 'viewer' : s ? 'auto' : 'boot';
    if (!s || fullAge >= FULL_EVERY_MS || s.today !== today()) start({ bearer: bearer || undefined, trigger, kind: 'full' });
    else if (anyAge >= NEAR_EVERY_MS) start({ bearer: bearer || undefined, trigger, kind: 'near' });
  }

  // ---------- reads ----------
  async function need() {
    const s = await load();
    if (!s) throw Object.assign(new Error('The schedule has not been loaded yet. It loads automatically within a few minutes, or click "Refresh now".'), { status: 409 });
    return s;
  }
  const cleanerOut = (c) => ({ id: c.id, lat: c.lat, lng: c.lng, name: c.name, status: c.status, status_label: STATUS_LABEL[c.status], assignable: c.assignable, is_new: c.isNew, gender: c.gender, hours_type: c.hoursType, color: c.color, area: c.area, phone: c.phone, weekly_hours: c.weekly_hours, tags: c.tags, rules: c.rules });

  async function status() {
    const last = await latestRun();
    const s = await load();
    return { taken_at: s?.taken_at || null, full_at: s?.full_at || s?.taken_at || null, running: !!running, last_error: last?.status === 'failed' ? last.error : null, refresh_minutes: NEAR_EVERY_MS / 60_000, full_minutes: FULL_EVERY_MS / 60_000 };
  }

  async function overview() {
    const s = await need();
    const weekStart = mondayOf(s.today);
    const weeks = Array.from({ length: 8 }, (_, i) => {
      const from = addDays(weekStart, i * 7);
      return { from, to: addDays(from, 6), cycle: cycleWeek(from) };
    });
    const active = s.cleaners.filter((c) => c.assignable || s.future.some((v) => v.team_ids.includes(c.id)));
    const rows = active.map((c) => ({
      ...cleanerOut(c),
      weeks: weeks.map((w) => {
        const booked = bookedHours(s, c.id, w.from < s.today ? s.today : w.from, w.to);
        const capacity = capacityHours(c, w.from < s.today ? s.today : w.from, w.to);
        const off = [...(unavailable.get(c.id) || [])].filter((d) => d >= w.from && d <= w.to).length;
        return { booked: Math.round(booked * 10) / 10, capacity: Math.round(capacity * 10) / 10, days_off: off };
      }),
    }));
    const unassigned = weeks.map((w) => Math.round(s.future.filter((v) => !v.team_ids.length && v.date >= w.from && v.date <= w.to).reduce((h, v) => h + v.duration / 60, 0) * 10) / 10);
    const open = await db.query('SELECT count(*)::int AS n FROM schedule_changes WHERE resolved_at IS NULL');
    return {
      taken_at: s.taken_at,
      today: s.today,
      weeks,
      rows: rows.sort((a, b) => Number(b.assignable) - Number(a.assignable) || a.name.localeCompare(b.name)),
      unassigned,
      areas: [...new Set(rows.map((r) => r.area))].sort(),
      counts: {
        cleaners: s.cleaners.length,
        assignable: s.cleaners.filter((c) => c.assignable).length,
        by_status: Object.fromEntries(Object.keys(STATUS_LABEL).map((k) => [k, s.cleaners.filter((c) => c.status === k).length])),
        unassigned_visits: s.future.filter((v) => !v.team_ids.length).length,
        future_visits: s.future.length,
        open_changes: open.rows[0].n,
      },
    };
  }

  const visitOut = (s, v) => ({
    key: v.key, id: v.id, date: v.date, start: v.start, duration: v.duration, time: clock(v.start), customer_id: v.customer_id, customer: v.customer,
    area: v.area, freq: FREQ_LABEL[v.kind], kind: v.kind, prepaid: v.prepaid, weeks: v.weeks, projected: !v.id,
    cleaners: v.team_ids.map((id) => ({ id, name: s.byId.get(id)?.name || 'Unknown' })),
  });

  // One cleaner over the next 4 weeks, laid out as weeks (A-D) by weekday.
  async function plan(cleanerId) {
    const s = await need();
    const c = s.byId.get(Number(cleanerId));
    if (!c) throw Object.assign(new Error('Unknown cleaner'), { status: 404 });
    const start = mondayOf(s.today);
    const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => c.availability.some((r) => !r.date && Number(r.weekday) === d && !r.dayoff) || s.future.some((v) => v.team_ids.includes(c.id) && weekday(v.date) === d));
    const weeks = Array.from({ length: 4 }, (_, i) => {
      const from = addDays(start, i * 7);
      const cells = days.map((wd) => {
        const d = addDays(from, (wd + 6) % 7);
        const visits = (s.busy.get(`${c.id}|${d}`) || []).slice().sort((a, b) => a.start - b.start);
        const w = windowFor(c, d);
        const gaps = d < s.today ? [] : openGaps(w, visits, 120).map(([a, b]) => ({ start: a, end: b, label: `${clock(a)}–${clock(b)}`, hours: Math.round((b - a) / 6) / 10 }));
        return { date: d, past: d < s.today, off: !w, unavailable: !!unavailable.get(c.id)?.has(d), hours: w ? `${clock(w[0])}–${clock(w[1])}` : null, visits: visits.map((v) => visitOut(s, v)), gaps };
      });
      const booked = bookedHours(s, c.id, from, addDays(from, 6));
      return { cycle: cycleWeek(from), from, to: addDays(from, 6), booked: Math.round(booked * 10) / 10, capacity: Math.round(capacityHours(c, from, addDays(from, 6)) * 10) / 10, cells };
    });
    // Continuity: of this cleaner's recurring clients, how many have them as main cleaner.
    const theirs = [...s.customers.values()].filter((cu) => cu.recurring && cu.future.some((v) => v.team_ids.includes(c.id)));
    const homeClients = theirs.filter((cu) => cu.main?.id === c.id).length;
    const ac = weeks[0].booked + weeks[2].booked;
    const bd = weeks[1].booked + weeks[3].booked;
    const cap = c.weekly_hours;
    const avg = weeks.reduce((a, w) => a + w.booked, 0) / 4;
    const hint = Math.abs(ac - bd) / 2 >= 3
      ? `Weeks ${ac > bd ? 'A/C' : 'B/D'} carry ${Math.round(Math.abs(ac - bd) / 2)}h more per week than ${ac > bd ? 'B/D' : 'A/C'}. Moving a biweekly client to the other week evens the load (dispatch contacts the customer first).`
      : cap - avg >= 3 ? `About ${Math.round(cap - avg)}h a week is still open. Click an open slot to see who could fill it.` : 'Nearly full and well balanced.';
    return { cleaner: cleanerOut(c), days: days.map((d) => DAYNAME[d]), weeks, avg_booked: Math.round(avg * 10) / 10, home_clients: homeClients, clients: theirs.length, hint };
  }

  // Options to fill one open gap of a cleaner.
  async function gapOptions(cleanerId, date, gapStart, gapEnd) {
    const s = await need();
    const c = s.byId.get(Number(cleanerId));
    if (!c) throw Object.assign(new Error('Unknown cleaner'), { status: 404 });
    const anchor = (s.busy.get(`${c.id}|${date}`) || [])[0] || c;
    const options = [];
    // Unassigned visits that day (or series that include that day) which fit.
    for (const v of s.future.filter((x) => !x.team_ids.length && x.date === date)) {
      const startAt = Math.max(gapStart, Math.min(v.start, gapEnd - v.duration));
      if (startAt + v.duration > gapEnd) continue;
      const f = fitsDay({ window: windowFor(c, date), busy: busyFor(s)(c.id, date), start: v.start, duration: v.duration, place: v, transit: c.rules.transit });
      const dist = km(anchor, v);
      if (!f.ok && !(v.start >= gapStart && v.end <= gapEnd)) continue;
      options.push({ type: 'unassigned', visit: visitOut(s, v), title: `${v.customer} · ${FREQ_LABEL[v.kind]}`, detail: `${clock(v.start)} · ${Math.round(v.duration / 6) / 10}h${v.area ? ` · ${v.area}` : ''} · needs a cleaner`, distance_km: dist == null ? null : Math.round(dist * 10) / 10, action: 'assign', exact: f.ok });
    }
    // A biweekly of this cleaner in the other phase, same weekday, that could move here.
    const opposite = addDays(date, 7);
    const back = addDays(date, -7);
    for (const v of [...(s.busy.get(`${c.id}|${opposite}`) || []), ...(s.busy.get(`${c.id}|${back}`) || [])].filter((x) => x.kind === 'bi')) {
      if (v.start < gapStart || v.start + v.duration > gapEnd) continue;
      options.push({ type: 'move', visit: visitOut(s, v), title: `Move ${v.customer} to this week`, detail: `Biweekly · same cleaner, weekday and time · evens out the weeks`, action: 'contact', exact: true });
    }
    options.sort((a, b) => Number(b.exact) - Number(a.exact) || (a.distance_km ?? 99) - (b.distance_km ?? 99));
    return { cleaner: cleanerOut(c), date, gap: { start: gapStart, end: gapEnd, label: `${clock(gapStart)}–${clock(gapEnd)}` }, options: options.slice(0, 8) };
  }

  // Unassigned visits grouped into series (customer + rhythm), with ranked cleaners.
  async function unassigned({ withCandidates = true, limit = 60 } = {}) {
    const s = await need();
    const ctx = ctxFor(s);
    const groups = new Map();
    for (const v of s.future.filter((x) => !x.team_ids.length)) {
      const k = `${v.customer_id}|${v.kind}|${weekday(v.date)}|${v.start}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v);
    }
    const out = [];
    for (const [k, list] of groups) {
      list.sort((a, b) => a.date.localeCompare(b.date));
      const v = list[0];
      const cust = s.customers.get(v.customer_id);
      const main = cust?.main ? s.byId.get(cust.main.id) : null;
      let why = null;
      if (main) {
        const w = windowFor(main, v.date);
        why = !main.assignable ? `Usual cleaner ${main.name} is ${STATUS_LABEL[main.status].toLowerCase()}` : !w ? `Usual cleaner ${main.name} isn't working ${DAYNAME[weekday(v.date)]}s` : `Usual cleaner is ${main.name}`;
      } else if (!cust?.past.length) why = 'New client: no usual cleaner yet';
      const job = { dates: list.map((x) => x.date), start: v.start, duration: v.duration, place: { lat: v.lat, lng: v.lng }, customerId: v.customer_id, kind: v.kind, services: v.services, prefs: cust?.prefs, mainCleanerId: cust?.main?.id, history: cust?.history, firstDate: v.date };
      out.push({
        key: k,
        customer_id: v.customer_id,
        customer: v.customer,
        freq: FREQ_LABEL[v.kind],
        kind: v.kind,
        prepaid: v.prepaid,
        when: `${DAYNAME[weekday(v.date)]} ${clock(v.start)}${v.kind === 'bi' ? ` · weeks ${v.weeks.split('').join('/')}` : v.kind === 'monthly' ? ` · week ${v.weeks}` : ''} · from ${nice(v.date)}`,
        duration: v.duration,
        area: v.area,
        first_date: v.date,
        visits: list.map((x) => visitOut(s, x)),
        projected: list.filter((x) => !x.id).length,
        why,
        candidates: withCandidates ? rankCleaners(job, s.cleaners, ctx, { limit: 4 }) : [],
      });
    }
    out.sort((a, b) => a.first_date.localeCompare(b.first_date));
    return { taken_at: s.taken_at, total_series: out.length, total_visits: s.future.filter((x) => !x.team_ids.length).length, series: out.slice(0, limit) };
  }

  async function continuity() {
    const s = await need();
    let clients = 0;
    let always = 0;
    let three = 0;
    let visits = 0;
    let withMain = 0;
    for (const cu of s.customers.values()) {
      const past = cu.past.filter((v) => v.kind !== 'one' && v.team_ids.length);
      if (past.length < 3) continue;
      clients++;
      const counts = new Map();
      for (const v of past) for (const id of v.team_ids) counts.set(id, (counts.get(id) || 0) + 1);
      const top = Math.max(...counts.values());
      const topId = [...counts].find(([, n]) => n === top)[0];
      visits += past.length;
      withMain += past.filter((v) => v.team_ids.includes(topId)).length;
      if (counts.size === 1) always++;
      if (counts.size >= 3) three++;
    }
    const until = addDays(s.today, 28);
    const upcoming = [];
    for (const v of s.future) {
      if (v.date > until || v.kind === 'one') continue;
      const cu = s.customers.get(v.customer_id);
      if (!cu?.main || v.team_ids.includes(cu.main.id)) continue;
      const main = s.byId.get(cu.main.id);
      if (!main) continue;
      const f = main.assignable ? fitsDay({ window: windowFor(main, v.date), busy: busyFor(s)(main.id, v.date), start: v.start, duration: v.duration, place: v, transit: main.rules.transit, ignoreKeys: new Set([v.key]) }) : { ok: false, reason: STATUS_LABEL[main.status].toLowerCase() };
      upcoming.push({ visit: visitOut(s, v), main: { id: main.id, name: main.name }, history: cu.main.visits, main_free: f.ok, why: f.ok ? 'Usual cleaner is free' : `Usual cleaner: ${f.reason}` });
    }
    const noMain = [...s.customers.values()].filter((cu) => cu.recurring && cu.future.length && !cu.main).length;
    return { taken_at: s.taken_at, clients, always, three_plus: three, visit_share: visits ? withMain / visits : null, upcoming_count: upcoming.length, upcoming: upcoming.slice(0, 100), without_main: noMain };
  }

  // What a client wants, in plain terms, for the cards.
  const titleCase = (x) => String(x || '').replace(/\b\w/g, (c) => c.toUpperCase());
  const PREF_TAG = /prefer|do\s*not\s*assign|female|\bmale\b|consistent|same cleaner/i;
  function clientOut(s, customerId) {
    const cu = customerId != null ? s.customers.get(customerId) : null;
    if (!cu) return null;
    const main = cu.main ? s.byId.get(cu.main.id) : null;
    return {
      id: cu.id,
      name: cu.name,
      phone: cu.phone || null,
      recurring: cu.recurring,
      main: main ? { id: main.id, name: main.name, visits: cu.main.visits, of: cu.main.of, available: main.assignable } : null,
      prefs: {
        female_only: cu.prefs.femaleOnly,
        prefers_female: cu.prefs.prefersFemale && !cu.prefs.femaleOnly,
        prefers_male: cu.prefs.prefersMale,
        consistent: cu.prefs.consistent,
        prefers: cu.prefs.prefers.map(titleCase),
        avoid: cu.prefs.avoid.map(titleCase),
      },
      notes: (cu.tags || []).filter((t) => !PREF_TAG.test(t)).slice(0, 6),
    };
  }

  async function changes() {
    const s = await need();
    const rows = (await db.query('SELECT * FROM schedule_changes WHERE resolved_at IS NULL ORDER BY due NULLS LAST, id')).rows;
    const ctx = ctxFor(s);
    const items = rows.map((r) => {
      const v = r.visit_key ? s.visits.find((x) => x.key === r.visit_key) : null;
      let suggestions = [];
      const series = r.kind === 'unassigned' && r.detail?.series ? unassignedSeries(s).get(r.detail.series) || (v ? [v] : []) : null;
      if (series?.length) {
        const cu = s.customers.get(v?.customer_id);
        const job = { dates: series.map((x) => x.date), start: series[0].start, duration: series[0].duration, place: { lat: series[0].lat, lng: series[0].lng }, kind: series[0].kind, services: series[0].services, prefs: cu?.prefs, mainCleanerId: cu?.main?.id, history: cu?.history, firstDate: series[0].date };
        suggestions = rankCleaners(job, s.cleaners, ctx, { limit: 4 });
      } else if (v && ['unassigned', 'outside_hours', 'double_booked', 'different_cleaner', 'cleaner_unavailable', 'moved', 'cleaner_changed'].includes(r.kind) && v.date >= s.today) {
        const cu = s.customers.get(v.customer_id);
        const job = { dates: [v.date], start: v.start, duration: v.duration, place: { lat: v.lat, lng: v.lng }, kind: v.kind, services: v.services, prefs: cu?.prefs, mainCleanerId: cu?.main?.id, history: cu?.history, firstDate: v.date };
        suggestions = rankCleaners(job, s.cleaners.filter((c) => !v.team_ids.includes(c.id) || r.kind === 'different_cleaner'), ctx, { limit: 4, ignoreKeys: new Set([v.key]) }).filter((x) => !v.team_ids.includes(x.cleaner_id));
        if (r.kind === 'different_cleaner') suggestions = suggestions.filter((x) => x.cleaner_id === cu?.main?.id);
      }
      const c = r.cleaner_id != null ? s.byId.get(Number(r.cleaner_id)) : null;
      const day = v?.date || dateStr(r.due);
      const w = c && day ? windowFor(c, day) : null;
      const cleaner = c ? { id: c.id, name: c.name, status: STATUS_LABEL[c.status], hours: w ? `${clock(w[0])}–${clock(w[1])}` : null, working: !!w } : null;
      const detail = { ...(r.detail || {}) };
      if (r.kind === 'availability' && Array.isArray(detail.affected)) detail.affected_visits = detail.affected.map((k) => s.visits.find((x) => x.key === k)).filter(Boolean).map((x) => visitOut(s, x));
      if (r.kind === 'moved' && detail.from) detail.from_label = `${nice(detail.from.date)} at ${clock(detail.from.start)}`;
      if (r.kind === 'moved' && detail.to) detail.to_label = `${nice(detail.to.date)} at ${clock(detail.to.start)}`;
      if (r.kind === 'cancelled' && detail.date) detail.when_label = `${nice(detail.date)} at ${clock(detail.start)}`;
      if (r.kind === 'cleaner_changed') {
        detail.from_names = (detail.from || []).map((id) => s.byId.get(id)?.name || 'Unknown');
        detail.to_names = (detail.to || []).map((id) => s.byId.get(id)?.name || 'Unknown');
      }
      const urgent = !!r.due && daysBetween(s.today, dateStr(r.due)) <= 2;
      return {
        id: Number(r.id), kind: r.kind, title: r.title, due: dateStr(r.due), urgent, days_away: r.due ? daysBetween(s.today, dateStr(r.due)) : null,
        detail, created_at: r.created_at, visit: v ? { ...visitOut(s, v), end: clock(v.end), services: v.services } : null,
        cleaner, client: clientOut(s, r.customer_id != null ? Number(r.customer_id) : v?.customer_id), suggestions,
        series: series ? { count: series.length, when: seriesWhen(series[0]), first: series[0].date, last: series.at(-1).date, visit_keys: series.map((x) => x.key), projected: series.filter((x) => !x.id).length } : null,
      };
    });
    return { taken_at: s.taken_at, today: s.today, items };
  }

  async function resolveChange(id, resolution, userId) {
    if (!['fixed', 'dismissed'].includes(resolution)) throw Object.assign(new Error('resolution must be fixed or dismissed'), { status: 400 });
    await db.query('UPDATE schedule_changes SET resolved_at = now(), resolution = $2, resolved_by = $3 WHERE id = $1 AND resolved_at IS NULL', [id, resolution, userId || null]);
  }

  // Best slots for a new or rescheduled booking.
  // cleaner: 'any' (default) or 'same' = only the client's usual cleaner (asked when a client
  // reschedules). With 'same' and nothing free, any_count says how many slots other cleaners have.
  async function findSlots({ customer_id, lat, lng, duration = 180, kind = 'one', from, days = 14, weekdays = null, earliest = 0, latest = 24 * 60, limit = 12, cleaner = 'any', booking_id = null } = {}) {
    const s = await need();
    const ctx = ctxFor(s);
    const cu = customer_id ? s.customers.get(Number(customer_id)) : null;
    let place = { lat: lat == null ? null : Number(lat), lng: lng == null ? null : Number(lng) };
    if (place.lat == null && cu) {
      const any = [...cu.future, ...cu.past].find((v) => v.lat != null);
      if (any) place = { lat: any.lat, lng: any.lng };
    }
    const k = ['weekly', 'bi', 'monthly', 'tri', 'one'].includes(kind) ? kind : frequencyKind(kind);
    const start = from && from >= s.today ? from : addDays(s.today, 1);
    const dur = Math.max(30, Math.min(Number(duration) || 180, 12 * 60));
    const horizon = addDays(s.today, AHEAD_DAYS);
    const main = cu?.main ? s.byId.get(cu.main.id) || null : null;
    const wantSame = cleaner === 'same';
    const sameApplies = wantSame && !!main;
    const pool = sameApplies ? [main] : s.cleaners;
    // Rescheduling: the booking being moved (and its projected repeats) doesn't block its own new time.
    const moving = booking_id ? String(booking_id) : null;
    const ignore = moving ? new Set(s.future.filter((v) => v.key === moving || v.key.startsWith(`f${moving}-`)).map((v) => v.key)) : null;
    const busyAt = (id, d) => { const b = busyFor(s)(id, d); return ignore ? b.filter((v) => !ignore.has(v.key)) : b; };
    const rankCtx = ignore ? { ...ctx, busyFor: busyAt } : ctx;
    const found = [];
    for (let i = 0; i < Math.min(Number(days) || 14, 28); i++) {
      const d = addDays(start, i);
      if (weekdays?.length && !weekdays.includes(weekday(d))) continue;
      for (const c of pool) {
        if (!c.assignable) continue;
        const w = windowFor(c, d);
        if (!w) continue;
        const gaps = openGaps(w, busyAt(c.id, d), dur);
        let picked = null;
        for (const [a, b] of gaps) {
          for (let t = Math.max(a, earliest); t + dur <= Math.min(b, latest); t += 30) {
            const f = fitsDay({ window: w, busy: busyAt(c.id, d), start: t, duration: dur, place, transit: c.rules.transit });
            if (f.ok) {
              picked = t;
              break;
            }
          }
          if (picked != null) break;
        }
        if (picked == null) continue;
        const dates = seriesDates(k, d, horizon);
        const job = { dates, start: picked, duration: dur, place, kind: k, prefs: cu?.prefs, mainCleanerId: cu?.main?.id, history: cu?.history, firstDate: d };
        const [rank] = rankCleaners(job, [c], rankCtx, { limit: 1, ignoreKeys: ignore });
        if (!rank || rank.fits < dates.length) continue; // recurring: must be free every time
        found.push({ date: d, day: DAYNAME[weekday(d)], start: picked, time: clock(picked), end: clock(picked + dur), cycle: cycleWeek(d), weeks: cycleWeeks(k, d), repeats: dates.length, cleaner: { id: c.id, name: c.name, color: c.color, is_new: c.isNew }, score: rank.score - i * 0.004, reasons: rank.reasons, travel: rank.travel });
      }
    }
    found.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const slots = [];
    for (const f of found) {
      const key = `${f.cleaner.id}|${f.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(f);
      if (slots.length >= limit) break;
    }
    let anyCount = null;
    if (sameApplies && !slots.length) {
      const other = await findSlots({ customer_id, lat, lng, duration, kind, from, days, weekdays, earliest, latest, limit, cleaner: 'any', booking_id });
      anyCount = other.slots.length;
    }
    return {
      place_known: place.lat != null,
      kind: k,
      frequency: FREQ_LABEL[k],
      duration: dur,
      customer: cu ? { id: cu.id, name: cu.name, main: main?.name || null } : null,
      cleaner: sameApplies ? 'same' : 'any',
      no_usual: wantSame && !main,
      any_count: anyCount,
      slots,
    };
  }

  // Assign a cleaner in Launch27 (signed-in user's login). Projected visits of a series can't
  // be assigned one by one in Launch27; they are reported back.
  async function assign({ visit_keys = [], cleaner_id, recommended = false }, bearer, email = null) {
    const s = await need();
    const logWrite = (entry) => (writes ? writes.record({ email, source: 'planner assign', method: 'POST', path: '/v1/staff/bookings/assign/teams', ...entry }) : Promise.resolve());
    if (!config.allowWrites) {
      await logWrite({ outcome: 'blocked', status: 403, body: { visit_keys, cleaner_id } });
      throw Object.assign(new Error('Writes to Launch27 are turned off here'), { status: 403 });
    }
    const c = s.byId.get(Number(cleaner_id));
    if (!c) throw Object.assign(new Error('Unknown cleaner'), { status: 404 });
    if (!c.assignable) throw Object.assign(new Error(`${c.name} is ${STATUS_LABEL[c.status].toLowerCase()} and can't take bookings`), { status: 400 });
    const visits = visit_keys.map((k) => s.visits.find((v) => v.key === String(k))).filter(Boolean);
    const real = visits.filter((v) => v.id);
    const projected = visits.filter((v) => !v.id);
    for (const v of real) {
      const payload = { booking_ids: [v.id], teams: [{ id: c.id, hours: Math.round((v.duration / 60) * 100) / 100, share: c.share || 0 }] };
      let res;
      try {
        res = await fetchImpl(`${config.l27BaseUrl}/v1/staff/bookings/assign/teams`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        await logWrite({ outcome: 'failed', body: payload, error: err.message });
        throw err;
      }
      await logWrite({ outcome: res.ok ? 'done' : 'refused', status: res.status, body: payload, error: res.ok ? null : `Launch27 answered ${res.status}` });
      if (!res.ok) throw Object.assign(new Error(`Launch27 refused the assignment for ${v.customer} on ${nice(v.date)} (${res.status})`), { status: 502 });
      // Reflect it right away; the next sync confirms.
      for (const old of v.team_ids) {
        const k = `${old}|${v.date}`;
        s.busy.set(k, (s.busy.get(k) || []).filter((x) => x.key !== v.key));
      }
      v.team_ids = [c.id];
      v.team_hours = { [c.id]: v.duration / 60 };
      const k = `${c.id}|${v.date}`;
      s.busy.set(k, [...(s.busy.get(k) || []), v]);
      await db.query('UPDATE schedule_changes SET resolved_at = now(), resolution = $2 WHERE visit_key = $1 AND resolved_at IS NULL', [v.key, recommended ? 'fixed_rec' : 'fixed']);
    }
    return { assigned: real.length, projected: projected.length, cleaner: c.name, confirm_first: c.rules.confirmFirst };
  }

  async function markUnavailable(cleanerId, day, { note, userId, on = true } = {}) {
    const s = await need();
    const c = s.byId.get(Number(cleanerId));
    if (!c) throw Object.assign(new Error('Unknown cleaner'), { status: 404 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw Object.assign(new Error('day must be YYYY-MM-DD'), { status: 400 });
    if (on) await db.query('INSERT INTO schedule_unavailable (cleaner_id, day, note, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (cleaner_id, day) DO UPDATE SET note = EXCLUDED.note', [c.id, day, note || null, userId || null]);
    else await db.query('DELETE FROM schedule_unavailable WHERE cleaner_id = $1 AND day = $2', [c.id, day]);
    await loadUnavailable();
    await db.tx((q) => recordChanges(q, problems(s)));
    const affected = (s.busy.get(`${c.id}|${day}`) || []).length;
    return { cleaner: c.name, day, unavailable: on, affected };
  }

  // Everything the cleaner profile needs from the planner's stored schedule.
  async function cleanerProfile(cleanerId) {
    const s = await need();
    const c = s.byId.get(Number(cleanerId));
    if (!c) throw Object.assign(new Error('This cleaner is not in the active list'), { status: 404 });
    const t = s.today;
    const mine = (from, to) => s.future.filter((v) => v.date >= from && v.date <= to && v.team_ids.includes(c.id)).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
    const todayVisits = mine(t, t);
    const next14 = mine(addDays(t, 1), addDays(t, 14));
    const weekStart = mondayOf(t);
    const week = [1, 2, 3, 4, 5, 6, 0].map((wd) => {
      const d = addDays(weekStart, (wd + 6) % 7);
      const w = windowFor(c, d);
      const booked = (s.busy.get(`${c.id}|${d}`) || []).reduce((m, v) => m + v.duration / Math.max(v.team_ids.length, 1), 0);
      return { date: d, day: DAYNAME[wd], past: d < t, working: !!w, unavailable: !!unavailable.get(c.id)?.has(d), capacity_h: w ? Math.round((w[1] - w[0]) / 6) / 10 : 0, booked_h: Math.round(booked / 6) / 10 };
    });
    // Today: their day in order, with drive estimates between visits and any problems.
    const w0 = windowFor(c, t);
    let prev = null;
    const today = todayVisits.map((v) => {
      const drive = prev ? travelMinutes(km(prev, v), c.rules.transit) : null;
      const issues = [];
      if (!w0) issues.push('Not a working day for them');
      else if (v.end > w0[1]) issues.push(`Ends after their ${clock(w0[1])} finish`);
      else if (v.start < w0[0]) issues.push(`Starts before their ${clock(w0[0])} start`);
      if (prev && prev.end + (drive || 0) > v.start) issues.push('Tight: not enough time to get there');
      prev = v;
      const cu = s.customers.get(v.customer_id);
      return { ...visitOut(s, v), end: clock(v.end), services: v.services, drive_before: drive, issues, note: cu?.prefs.consistent ? 'wants the same cleaner every time' : null };
    });
    // Clients who asked never to have them; usual hours as plain text.
    const avoidedBy = [...s.customers.values()].filter((cu) => cu.prefs.avoid.some((n) => nameMatches(c.name, n))).length;
    const rows = c.availability || [];
    const groups = [];
    for (const wd of [1, 2, 3, 4, 5, 6, 0]) {
      const r = rows.find((x) => !x.date && Number(x.weekday) === wd);
      const label = r && !r.dayoff && r.start_time && r.end_time ? `${clock(toMinutesHM(r.start_time))} – ${clock(toMinutesHM(r.end_time))}` : 'Off';
      const g = groups.at(-1);
      if (g && g.label === label) g.days.push(DAYNAME[wd]);
      else groups.push({ label, days: [DAYNAME[wd]] });
    }
    const hours = groups.map((g) => ({ days: g.days.length > 2 ? `${g.days[0]} – ${g.days.at(-1)}` : g.days.join(', '), label: g.label }));
    const daysOff = [...(unavailable.get(c.id) || [])].filter((d) => d >= t).sort();
    return {
      taken_at: s.taken_at,
      today_date: t,
      cleaner: { ...cleanerOut(c), title: c.title },
      hours,
      days_off: daysOff,
      week: { days: week, booked_h: Math.round(week.reduce((a, d) => a + d.booked_h, 0) * 10) / 10, capacity_h: Math.round(week.reduce((a, d) => a + d.capacity_h, 0) * 10) / 10 },
      today,
      today_drive_min: today.reduce((a, v) => a + (v.drive_before || 0), 0),
      next14: { cleans: next14.length, hours: Math.round(next14.reduce((a, v) => a + v.duration / Math.max(v.team_ids.length, 1), 0) / 6) / 10 },
      rules: [
        c.rules.maxTravelMin ? `Max ${c.rules.maxTravelMin} minutes travel to a booking` : null,
        ...c.rules.doNotPair.map((n) => `Never paired with ${n.replace(/\b\w/g, (x) => x.toUpperCase())} on a booking`),
        c.rules.noShort ? 'No short (2-hour) bookings' : null,
        c.rules.confirmFirst ? 'Call or text to confirm before giving them a new booking' : null,
        c.rules.lastMinute ? 'Happy to take last-minute bookings' : null,
        c.rules.transit ? 'Travels by public transit' : null,
        avoidedBy ? `${avoidedBy} client${avoidedBy === 1 ? ' has' : 's have'} asked never to have them` : null,
      ].filter(Boolean),
    };
  }

  async function cleaners() {
    const s = await need();
    return { cleaners: s.cleaners.map(cleanerOut).sort((a, b) => Number(b.assignable) - Number(a.assignable) || a.name.localeCompare(b.name)) };
  }

  // QA/dev only: the data underneath changed completely (a new QA copy, or back to sample
  // data). Forget the stored snapshot and open items so nothing is compared across the switch.
  // True when the stored snapshot was taken from different data than what is served now.
  async function dataChanged() {
    if (config.l27Mode !== 'mock') return false;
    const loaded = await load();
    return !!loaded && loaded.sample !== dataTag();
  }
  async function reset() {
    if (config.l27Mode !== 'mock') throw new Error('reset is only for sample/QA data');
    if (running) await running;
    await db.tx(async (q) => {
      await q.query('DELETE FROM schedule_snapshots');
      await q.query("UPDATE schedule_changes SET resolved_at = now(), resolution = 'gone' WHERE resolved_at IS NULL");
      await q.query('DELETE FROM schedule_unavailable');
    });
    snap = null;
  }
  return { reset, dataChanged, cleanerProfile, sync, start, soon, maybeRun, status, overview, plan, gapOptions, unassigned, continuity, changes, resolveChange, findSlots, assign, markUnavailable, cleaners, isRunning: () => !!running, _load: load };
}

