// Scheduling insights and cleaner reports. Nightly (after 4 am Toronto, and at boot if never
// run) a read-only sync pulls a year of bookings, check-in/out times, ratings and cleaner pay
// from Launch27 and stores them slimmed; reports are computed from that plus the planner's
// live schedule. Cleaner pay is only returned to admins.
import { addDays, localDate, mondayOf } from '../schedule/rules.js';
import { harmonizePartners } from '../commercial/partners.js';
import { clampRange, utilizationFacts, utilizationReport } from './utilization.js';
import { UTILIZATION } from './utilization-config.js';
import { PERIODS, cleanerRow, cleanerStats, emptyStats, flagsFor, indexVisits, median, outsideArea, pct, periodRange, regularClients, round1, sameCleaner, slimReportVisit, teamLong, timing, weeklySeries } from './compute.js';
import { CHANGE_LOG_START, DROP_REASONS, RAISE_THRESHOLDS } from './raise-config.js';
import { ladderOf, raiseReview, rateHistory, reliability, reliabilityWeeks, restrictiveTags, slackSummary } from './raise.js';

const VERDICT_RANK = { ready: 4, watch: 3, not_yet: 2, ceiling: 1, ladder: 1, thin: 0 };

const DAYS_BACK = 365;
const HOUR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hourCycle: 'h23' });

export function createReports({ db, config, fetchImpl = fetch, schedule, log = { info() {}, warn() {}, error() {} }, now = () => Date.now() }) {
  let snap = null;
  let running = null;
  let lastAttempt = 0;
  const cache = new Map();
  const today = () => localDate(now());

  const get = async (bearer, path, query = {}) => {
    const u = new URL(config.l27BaseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
    const res = await fetchImpl(u.toString(), { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Launch27 ${path} returned ${res.status}`);
    return res.json();
  };
  const pullRange = async (bearer, path, from, to, query = {}) => {
    const out = new Map();
    for (let a = from; a <= to; a = addDays(a, 30)) {
      const b = addDays(a, 29) < to ? addDays(a, 29) : to;
      for (let page = 0; page < 300; page++) {
        const rows = await get(bearer, path, { ...query, from: a, to: b, limit: 100, offset: page * 100 });
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) out.set(r.id, r);
        if (rows.length < 100) break;
      }
    }
    return out;
  };
  async function syncBearer() {
    const creds = config.l27Mode === 'mock' ? { email: 'reports-sync@example.com', password: config.mockPassword || 'demo' } : config.l27SyncEmail && config.l27SyncPassword ? { email: config.l27SyncEmail, password: config.l27SyncPassword } : null;
    if (!creds) return null;
    const res = await fetchImpl(`${config.l27BaseUrl}/latest/login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(creds), signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.bearer) throw new Error(`Launch27 login for the reports sync failed (${res.status})`);
    return body.bearer;
  }

  async function load() {
    if (snap) return snap;
    const row = (await db.query("SELECT taken_at, data FROM report_snapshots WHERE status = 'done' ORDER BY id DESC LIMIT 1")).rows[0];
    if (row) {
      const visits = harmonizePartners(row.data.visits);
      snap = { ...row.data, visits, taken_at: new Date(row.taken_at).toISOString(), byCustomer: indexVisits(visits) };
    }
    return snap;
  }

  async function sync({ bearer } = {}) {
    lastAttempt = now();
    try {
      bearer = bearer || (await syncBearer());
      if (!bearer) throw new Error('No Launch27 login for the reports sync (set L27_SYNC_EMAIL and L27_SYNC_PASSWORD)');
      const t = today();
      const from = addDays(t, -DAYS_BACK);
      const to = addDays(t, -1);
      const bookings = await pullRange(bearer, '/v1/staff/bookings', from, to);
      const tracking = await pullRange(bearer, '/v1/staff/bookings/time_tracking', from, to);
      const rated = await pullRange(bearer, '/v1/staff/bookings', from, to, { options: 'with_feedback' });
      const visits = [];
      for (const [id, b] of bookings) {
        if (b.active === false) continue;
        visits.push(slimReportVisit(b, tracking.get(id), rated.get(id)));
      }
      visits.splice(0, visits.length, ...harmonizePartners(visits));
      // Hospital programs were booked under the Ottawa (Residential) location until spring
      // 2026; they are Commercial work, so count them under the Commercial location.
      const commercialLoc = visits.find((v) => /commercial/i.test(v.location_name || ''))?.location_id || null;
      if (commercialLoc) for (const v of visits) if (v.partner_kind === 'program' && !/commercial|cornwall/i.test(v.location_name || '')) v.location_id = commercialLoc;
      const data = { today: t, from, to, visits };
      await db.tx(async (q) => {
        await q.query('INSERT INTO report_snapshots (data) VALUES ($1::jsonb)', [JSON.stringify(data)]);
        await q.query('DELETE FROM report_snapshots WHERE id NOT IN (SELECT id FROM report_snapshots ORDER BY id DESC LIMIT 2)');
      });
      snap = { ...data, taken_at: new Date(now()).toISOString(), byCustomer: indexVisits(visits) };
      cache.clear();
      log.info('reports updated', { visits: visits.length });
      return { visits: visits.length };
    } catch (err) {
      await db.query("INSERT INTO report_snapshots (status, error) VALUES ('failed', $1)", [String(err.message).slice(0, 500)]).catch(() => {});
      log.error('reports sync failed', { error: err.message });
      throw err;
    }
  }
  function start(opts) {
    if (!running) running = sync(opts).catch(() => null).finally(() => (running = null));
    return running;
  }
  async function maybeRun() {
    if (running || now() - lastAttempt < 30 * 60_000) return;
    if (config.l27Mode !== 'mock' && !(config.l27SyncEmail && config.l27SyncPassword)) return;
    const s = await load();
    const due = !s || (s.today < today() && Number(HOUR.format(new Date(now()))) >= 4);
    if (due) start();
  }

  async function need() {
    const s = await load();
    if (!s) throw Object.assign(new Error('Reports have not been built yet. They build automatically overnight, or click "Refresh now".'), { status: 409 });
    return s;
  }

  // One brand's view (brand switcher): only visits at its Launch27 locations. null = both brands.
  const locKey = (locations) => (Array.isArray(locations) && locations.length ? [...new Set(locations.map(Number))].sort((a, b) => a - b).join(',') : '');
  const scopes = new Map();
  async function needScoped(locations) {
    const s = await need();
    const key = locKey(locations);
    if (!key) return s;
    const ck = `${s.taken_at}|${key}`;
    if (!scopes.has(ck)) {
      if (scopes.size > 20) scopes.clear();
      const ids = new Set(key.split(',').map(Number));
      const visits = s.visits.filter((v) => ids.has(Number(v.location_id)));
      scopes.set(ck, { ...s, visits, byCustomer: indexVisits(visits) });
    }
    return scopes.get(ck);
  }

  // Forward-looking numbers from the planner (next 4 weeks), per cleaner and by area.
  async function plannerView(locations = null) {
    try {
      const ov = await schedule.overview({ locations });
      const key = locKey(locations);
      if (key) {
        // Only cleaners working in this brand's locations (shared cleaners count in both).
        const ids = new Set(key.split(',').map(Number));
        ov.rows = ov.rows.filter((r) => !r.location_ids?.length || r.location_ids.some((id) => ids.has(Number(id))));
      }
      const util = new Map();
      for (const r of ov.rows) {
        const w = r.weeks.slice(0, 4);
        const booked = w.reduce((a, x) => a + x.booked, 0) / 4;
        const capacity = w.reduce((a, x) => a + x.capacity, 0) / 4;
        util.set(r.id, { booked, capacity, ac: (w[0]?.booked || 0) + (w[2]?.booked || 0), bd: (w[1]?.booked || 0) + (w[3]?.booked || 0), row: r });
      }
      return { ov, util };
    } catch {
      return { ov: null, util: new Map() };
    }
  }

  async function scheduling(period = '13w', { locations = null } = {}) {
    const s = await needScoped(locations);
    const key = `sched|${period}|${s.taken_at}|${locKey(locations)}`;
    if (cache.has(key)) return { ...cache.get(key), planner: await plannerHealth(period) };
    const { from, to } = periodRange(s.today, period);
    const sc = sameCleaner(s.visits, s.byCustomer, from, to);
    const { ov, util } = await plannerView(locations);
    const cleanerInfo = new Map((ov?.rows || []).map((r) => [r.id, r]));
    let tracked = 0, onTime = 0, long = 0, enroute = 0;
    const late = [];
    const km = [];
    const drives = [];
    let outside = 0, outsideN = 0;
    const perCleaner = new Map();
    for (const v of s.visits) {
      if (v.date < from || v.date > to) continue;
      for (const t of v.teams) {
        const tm = timing(v, t);
        if (!tm) continue;
        tracked++;
        if (tm.onTime) onTime++;
        else late.push(tm.late);
        if (tm.long) long++;
        if (tm.enroute) enroute++;
        const info = cleanerInfo.get(t.id);
        const out = outsideArea(v, info);
        if (out != null) {
          outsideN++;
          if (out) outside++;
        }
        const pc = perCleaner.get(t.id) || { id: t.id, name: info?.name || t.name, area: info?.area || null, km: [], tracked: 0, enroute: 0, outside: 0, outsideN: 0 };
        pc.tracked++;
        if (tm.enroute) pc.enroute++;
        if (out != null) {
          pc.outsideN++;
          if (out) pc.outside++;
        }
        if (tm.distance != null) {
          km.push(tm.distance);
          pc.km.push(tm.distance);
          drives.push({ cleaner: info?.name || t.name, cleaner_id: t.id, date: v.date, km: round1(tm.distance), area_out: !!out, customer: v.customer });
        }
        perCleaner.set(t.id, pc);
      }
    }
    // Hours filled by area (next 4 weeks).
    const areas = new Map();
    for (const [, u] of util) {
      if (!u.row.assignable) continue;
      const a = areas.get(u.row.area) || { area: u.row.area, booked: 0, capacity: 0 };
      a.booked += u.booked;
      a.capacity += u.capacity;
      areas.set(u.row.area, a);
    }
    const totalBooked = [...areas.values()].reduce((x, a) => x + a.booked, 0);
    const totalCap = [...areas.values()].reduce((x, a) => x + a.capacity, 0);
    const lopsided = [...util.values()].filter((u) => u.row.assignable && Math.abs(u.ac - u.bd) / 2 >= 8).map((u) => ({ cleaner_id: u.row.id, name: u.row.name, ac: round1(u.ac / 2), bd: round1(u.bd / 2) })).sort((a, b) => Math.abs(b.ac - b.bd) - Math.abs(a.ac - a.bd)).slice(0, 8);
    const out = {
      taken_at: s.taken_at, period, from, to,
      kpis: {
        same_cleaner: sc.share, same_cleaner_visits: sc.visits,
        on_time: pct(onTime, tracked), late_avg: late.length ? Math.round(late.reduce((a, b) => a + b, 0) / late.length) : null, check_ins: tracked,
        ran_long: pct(long, tracked),
        hours_filled: pct(totalBooked, totalCap),
        unassigned_visits: ov?.counts.unassigned_visits ?? null,
        km_per_visit: km.length ? round1(km.reduce((a, b) => a + b, 0) / km.length) : null,
        enroute: pct(enroute, tracked),
        outside_area: pct(outside, outsideN),
      },
      same_cleaner_series: sc.series,
      areas: [...areas.values()].map((a) => ({ area: a.area, filled: pct(a.booked, a.capacity), booked: round1(a.booked), capacity: round1(a.capacity) })).sort((a, b) => (b.filled ?? 0) - (a.filled ?? 0)),
      lopsided,
      longest_drives: drives.sort((a, b) => b.km - a.km).slice(0, 10),
      driving: [...perCleaner.values()].filter((p) => p.tracked >= 3).map((p) => ({ cleaner_id: p.id, name: p.name, area: p.area, km_per_visit: p.km.length ? round1(p.km.reduce((a, b) => a + b, 0) / p.km.length) : null, enroute: pct(p.enroute, p.tracked), outside_area: pct(p.outside, p.outsideN), visits: p.tracked })).sort((a, b) => (b.km_per_visit ?? 0) - (a.km_per_visit ?? 0)),
    };
    cache.set(key, out);
    return { ...out, planner: await plannerHealth(period) };
  }

  // How the planner's Changes to handle are being worked.
  async function plannerHealth(period) {
    const days = PERIODS[period] || 91;
    const rows = (await db.query("SELECT created_at, resolved_at, resolution FROM schedule_changes WHERE created_at > now() - ($1 || ' days')::interval", [String(days)])).rows;
    const handled = rows.filter((r) => r.resolution && ['fixed', 'fixed_rec', 'dismissed'].includes(r.resolution));
    const fixed = handled.filter((r) => r.resolution !== 'dismissed');
    const hours = handled.map((r) => (new Date(r.resolved_at) - new Date(r.created_at)) / 3_600_000);
    return {
      raised: rows.length,
      handled: handled.length,
      handled_share: pct(handled.length, rows.filter((r) => r.resolution !== 'gone').length),
      median_hours: hours.length ? round1(median(hours)) : null,
      recommended_share: pct(fixed.filter((r) => r.resolution === 'fixed_rec').length, fixed.length),
      expired: rows.filter((r) => r.resolution === 'past').length,
      open: rows.filter((r) => !r.resolved_at).length,
    };
  }

  // ---------- raise readiness: data kept in this app ----------
  // Drops (cleaner taken off a visit), complaints tagged with a cleaner, Google reviews.
  async function sideData(since) {
    const safe = (p) => p.then((r) => r.rows).catch((err) => {
      log.warn('raise readiness data unavailable', { error: err.message });
      return [];
    });
    const [drops, complaints, reviews] = await Promise.all([
      safe(db.query('SELECT id, cleaner_id, visit_key, booking_id, customer, visit_at, dropped_at, reason, source FROM cleaner_drops WHERE dropped_at >= $1 ORDER BY dropped_at', [`${since}T00:00:00Z`])),
      safe(db.query("SELECT id, cleaner_id, cleaner_name, subject, created_at, complaint FROM conversations WHERE cleaner_id IS NOT NULL AND complaint IS NOT NULL AND created_at >= $1 ORDER BY created_at DESC", [`${since}T00:00:00Z`])),
      safe(db.query('SELECT id, cleaner_id, review_date, reviewer, link, bonus_paid, created_at FROM cleaner_google_reviews ORDER BY review_date DESC')),
    ]);
    const group = (rows) => {
      const m = new Map();
      for (const r of rows) {
        const k = Number(r.cleaner_id);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return m;
    };
    const iso = (x) => (x instanceof Date ? x.toISOString() : String(x));
    const day = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
    return {
      drops: group(drops.map((d) => ({ ...d, id: Number(d.id), visit_at: iso(d.visit_at), dropped_at: iso(d.dropped_at), dropped_on: localDate(d.dropped_at), visit_date: localDate(d.visit_at) }))),
      complaints: group(complaints.map((c) => ({ id: Number(c.id), cleaner_id: Number(c.cleaner_id), subject: c.subject, date: localDate(c.created_at), outcome: c.complaint?.outcome || null, status: c.complaint?.status || null, booking_id: c.complaint?.booking_id ?? null }))),
      reviews: group(reviews.map((r) => ({ id: Number(r.id), cleaner_id: Number(r.cleaner_id), date: day(r.review_date), reviewer: r.reviewer, link: r.link, bonus_paid: !!r.bonus_paid }))),
    };
  }

  // Pay rate on each visit, per cleaner (from the whole snapshot), cached per build.
  const rateCache = new Map();
  function ratesFor(s) {
    if (!rateCache.has(s.taken_at)) {
      rateCache.clear();
      const m = new Map();
      for (const v of s.visits) for (const t of v.teams) {
        if (!m.has(t.id)) m.set(t.id, []);
        m.get(t.id).push({ date: v.date, rate: t.rate });
      }
      const out = new Map();
      for (const [id, pts] of m) out.set(id, { history: rateHistory(pts), first: pts.reduce((a, p) => (!a || p.date < a ? p.date : a), null) });
      rateCache.set(s.taken_at, out);
    }
    return rateCache.get(s.taken_at);
  }

  // Start date: Launch27's provider created date when known, else their first visit in the
  // last 12 months ("at least" when that is near the start of what we have).
  function startOf(info, rates, s) {
    if (info?.created_at) return { date: localDate(info.created_at), known: true };
    const first = rates?.first || null;
    if (!first) return { date: null, known: false };
    return { date: first, known: first > addDays(s.from, 14) };
  }

  // The 13-week figures the verdict is built from.
  function raiseInput({ st, info, s, side, rates, ratedShare, today13, from13, to13 }) {
    const row = cleanerRow(st);
    const start = startOf(info, rates, s);
    const rel = reliability({ drops: side.drops.get(st.id) || [], checks: { missing: st.missing, late: [] }, from: from13, to: today13 });
    return {
      today: today13,
      start_date: start.date,
      start_known: start.known,
      visits: st.visits,
      rated: st.rated,
      happy: row.happy,
      stars: info?.stars ?? null,
      stars_count: info?.ratings_count ?? null,
      rated_share: ratedShare,
      on_time: row.on_time,
      tracked: st.tracked,
      reliability: rel,
      residential: st.residential,
      early_share: row.finished_early,
      complaints: (side.complaints.get(st.id) || []).filter((c) => c.date >= from13 && c.date <= today13).length,
      keeps: row.keeps,
      clients_started: row.clients_started,
      hours_per_week: round1((row.onsite_hours || row.booked_hours) / (RAISE_THRESHOLDS.windowDays / 7)),
      restrictive: restrictiveTags(info?.tags || []),
      google_reviews: (side.reviews.get(st.id) || []).filter((r) => r.date >= from13 && r.date <= today13).length,
      rate: rates?.history?.current ?? null,
      ladder: ladderOf(info?.tags || []),
      margin: row.margin,
      _to: to13,
    };
  }

  const ratedShareOf = (s, from, to) => pct(new Set(s.visits.filter((v) => v.date >= from && v.date <= to && v.rating).map((v) => v.id)).size, s.visits.filter((v) => v.date >= from && v.date <= to).length);

  async function cleaners(period = '13w', { admin = false, locations = null } = {}) {
    const s = await needScoped(locations);
    const { from, to, days } = periodRange(s.today, period);
    const stats = cleanerStats(s.visits, s.byCustomer, from, to, s.today);
    const r13 = periodRange(s.today, '13w');
    const stats13 = period === '13w' ? stats : cleanerStats(s.visits, s.byCustomer, r13.from, r13.to, s.today);
    const today = localDate(now());
    const side = await sideData(from < r13.from ? from : r13.from);
    const rates = ratesFor(s);
    const ratedShare13 = ratedShareOf(s, r13.from, r13.to);
    const team = teamLong(stats);
    const { ov, util } = await plannerView(locations);
    const info = new Map((ov?.rows || []).map((r) => [r.id, r]));
    const rows = [];
    for (const st of stats.values()) {
      const i = info.get(st.id);
      const u = util.get(st.id);
      const row = cleanerRow(st, { name: i?.name });
      const rel = reliability({ drops: side.drops.get(st.id) || [], checks: { missing: st.missing, late: [] }, from, to: today });
      let raise;
      if (admin) {
        const st13 = stats13.get(st.id) || emptyStats(st.id, st.name);
        const review = raiseReview(raiseInput({ st: st13, info: i, s, side, rates: rates.get(st.id), ratedShare: ratedShare13, today13: today, from13: r13.from, to13: r13.to }));
        raise = { verdict: review.verdict, label: review.label, re_review: review.re_review, rank: VERDICT_RANK[review.verdict] ?? 0 };
      }
      rows.push({
        ...row,
        earned: admin ? row.earned : undefined,
        margin: admin ? row.margin : undefined,
        status: i?.status || 'unknown', status_label: i?.status_label || 'Not in the active list', assignable: !!i?.assignable, area: i?.area || null, color: i?.color || '#94A3B8', is_new: !!i?.is_new, hours_type: i?.hours_type || null,
        hours_per_week: round1((row.onsite_hours || row.booked_hours) / (days / 7)),
        hours_filled: u && u.capacity ? pct(u.booked, u.capacity) : null,
        stars: i?.stars ?? null, ratings_count: i?.ratings_count ?? null,
        reliability: { issues: rel.issues, no_shows: rel.no_shows, last_minute: rel.last_minute, short_notice: rel.short_notice, missing_checks: rel.missing_checks, partial: rel.partial, covers_from: rel.covers_from, uncoded: rel.uncoded },
        raise,
        flags: flagsFor(st, u, team),
      });
    }
    rows.sort((a, b) => b.visits - a.visits);
    const all = rows.filter((r) => r.visits);
    const tot = (k) => all.reduce((a, r) => a + (r[k] || 0), 0);
    const sumStats = [...stats.values()];
    const tracked = sumStats.reduce((a, s2) => a + s2.tracked, 0);
    return {
      taken_at: s.taken_at, period, from, to, admin,
      change_log_start: CHANGE_LOG_START,
      raise_window: admin ? { from: r13.from, to: today } : undefined,
      team: {
        cleaners: all.length,
        median_visits: median(all.map((r) => r.visits)),
        max_visits: all.length ? Math.max(...all.map((r) => r.visits)) : 0,
        on_time: pct(sumStats.reduce((a, s2) => a + s2.onTime, 0), tracked),
        check_ins: tracked,
        happy: pct(sumStats.reduce((a, s2) => a + s2.happy, 0), sumStats.reduce((a, s2) => a + s2.rated, 0)),
        rated_share: ratedShareOf(s, from, to),
        revenue: tot('revenue'),
        earned: admin ? tot('earned') : undefined,
        flagged: rows.filter((r) => r.flags.length && r.assignable).length,
        runs_long_median: team.median,
        raise_ready: admin ? rows.filter((r) => r.raise?.verdict === 'ready').length : undefined,
      },
      rows,
    };
  }

  async function cleaner(id, period = '13w', { admin = false, locations = null } = {}) {
    const s = await needScoped(locations);
    const cid = Number(id);
    const { from, to, days } = periodRange(s.today, period);
    const stats = cleanerStats(s.visits, s.byCustomer, from, to, s.today);
    const st = stats.get(cid);
    const { ov, util } = await plannerView(locations);
    const i = (ov?.rows || []).find((r) => r.id === cid);
    if (!st && !i) throw Object.assign(new Error('No report for this cleaner'), { status: 404 });
    const base = st || emptyStats(cid, i?.name);
    const row = cleanerRow(base, { name: i?.name });
    const u = util.get(cid);
    const today = localDate(now());
    const r13 = periodRange(s.today, '13w');
    const stats13 = period === '13w' ? stats : cleanerStats(s.visits, s.byCustomer, r13.from, r13.to, s.today);
    const side = await sideData(from < r13.from ? from : r13.from);
    const rates = ratesFor(s).get(cid);
    const team = teamLong(stats);
    const start = startOf(i, rates, s);
    const lastRatings = s.visits.filter((v) => v.rating && v.teams.some((t) => t.id === cid)).sort((a, b) => b.at - a.at).slice(0, 8).map((v) => ({ date: v.date, customer: v.customer, r: v.rating.r, comment: v.rating.comment }));
    const firstSeen = rates?.first || null;
    const rel = reliability({ drops: side.drops.get(cid) || [], checks: { missing: base.missing, late: base.lateList }, from, to: today });
    let raise;
    if (admin) {
      const st13 = stats13.get(cid) || emptyStats(cid, i?.name);
      const input = raiseInput({ st: st13, info: i, s, side, rates, ratedShare: ratedShareOf(s, r13.from, r13.to), today13: today, from13: r13.from, to13: r13.to });
      const review = raiseReview(input);
      const name = i?.name || row.name;
      raise = {
        ...review,
        from: r13.from,
        to: today,
        rate: rates?.history || null,
        margin: input.margin,
        summary: slackSummary({ name, review, rate: rates?.history || null, from: r13.from, to: today }),
      };
    }
    return {
      taken_at: s.taken_at, period, from, to, admin,
      change_log_start: CHANGE_LOG_START,
      cleaner: { id: cid, name: i?.name || row.name, status: i?.status || 'unknown', status_label: i?.status_label || 'Not in the active list', area: i?.area || null, color: i?.color || '#94A3B8', tags: i?.tags || [], hours_type: i?.hours_type || null, phone: i?.phone || null, weekly_hours: i?.weekly_hours ?? null, first_seen: firstSeen, start_date: start.date, start_known: start.known, stars: i?.stars ?? null, ratings_count: i?.ratings_count ?? null, restrictive: restrictiveTags(i?.tags || []) },
      stats: { ...row, earned: admin ? row.earned : undefined, margin: admin ? row.margin : undefined, hours_per_week: round1((row.onsite_hours || row.booked_hours) / (days / 7)), hours_filled: u && u.capacity ? pct(u.booked, u.capacity) : null, booked_next4: u ? round1(u.booked) : null, capacity_next4: u ? round1(u.capacity) : null, per_hour: admin && row.earned && row.onsite_hours ? round1(row.earned / row.onsite_hours) : undefined },
      flags: flagsFor(base, u, team),
      team: { runs_long_median: team.median },
      series: weeklySeries(s.visits, cid, from, to),
      clients: regularClients(cid, s.byCustomer, now()).slice(0, 25),
      lost: (base.lost || []).map((l) => ({ customer: l.customer, stopped: l.stopped, to: l.to != null ? (ov?.rows.find((r) => r.id === l.to)?.name || 'another cleaner') : null })),
      ratings: lastRatings,
      last40: [...(base.last40 || [])].reverse(),
      reliability: { ...rel, weeks: reliabilityWeeks(rel, from, today) },
      finished_early: [...base.earlyList].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30),
      complaints: (side.complaints.get(cid) || []).filter((c) => c.date >= from),
      google_reviews: side.reviews.get(cid) || [],
      raise,
    };
  }

  // ---------- drops: record and code ----------
  // Dispatch removes a cleaner (reason picked there), or someone codes a drop the sync found.
  async function recordDrop({ cleaner_id, visit_key, booking_id = null, customer = null, visit_at, reason }, userId) {
    if (!DROP_REASONS[reason]) throw Object.assign(new Error('Pick a reason'), { status: 400 });
    const cid = Number(cleaner_id);
    const key = String(visit_key || booking_id || '');
    if (!cid || !key) throw Object.assign(new Error('cleaner_id and visit_key are required'), { status: 400 });
    const at = Date.parse(visit_at);
    if (!Number.isFinite(at)) throw Object.assign(new Error('visit_at must be a date and time'), { status: 400 });
    const row = (await db.query(
      `INSERT INTO cleaner_drops (cleaner_id, visit_key, booking_id, customer, visit_at, dropped_at, reason, source, coded_by, coded_at) VALUES ($1,$2,$3,$4,$5,now(),$6,'dispatch',$7,now())
       ON CONFLICT (visit_key, cleaner_id) DO UPDATE SET reason = EXCLUDED.reason, coded_by = EXCLUDED.coded_by, coded_at = now() RETURNING id`,
      [cid, key, booking_id ? Number(booking_id) : null, customer ? String(customer).slice(0, 200) : null, new Date(at).toISOString(), reason, userId || null],
    )).rows[0];
    return { id: Number(row.id) };
  }

  // Code the drops behind one "Cleaner changed" card.
  async function codeChange(changeId, reason, userId) {
    if (!DROP_REASONS[reason]) throw Object.assign(new Error('Pick a reason'), { status: 400 });
    const res = await db.query('UPDATE cleaner_drops SET reason = $2, coded_by = $3, coded_at = now() WHERE change_id = $1 RETURNING id', [Number(changeId), reason, userId || null]);
    return { coded: res.rows.length };
  }
  async function dropsForChanges(ids) {
    if (!ids.length) return new Map();
    const rows = (await db.query('SELECT change_id, cleaner_id, reason FROM cleaner_drops WHERE change_id = ANY($1::bigint[])', [ids.map(Number)])).rows;
    const m = new Map();
    for (const r of rows) {
      const k = Number(r.change_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ cleaner_id: Number(r.cleaner_id), reason: r.reason });
    }
    return m;
  }

  // ---------- Google reviews (phase 1: typed in) ----------
  async function addReview(cleanerId, { review_date, reviewer, link = null, bonus_paid = false }, userId) {
    const d = String(review_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw Object.assign(new Error('Review date is required'), { status: 400 });
    if (!String(reviewer || '').trim()) throw Object.assign(new Error('Reviewer is required'), { status: 400 });
    if (link && !/^https?:\/\//i.test(String(link))) throw Object.assign(new Error('Link must start with http'), { status: 400 });
    const row = (await db.query('INSERT INTO cleaner_google_reviews (cleaner_id, review_date, reviewer, link, bonus_paid, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [Number(cleanerId), d, String(reviewer).trim().slice(0, 200), link ? String(link).slice(0, 1000) : null, !!bonus_paid, userId || null])).rows[0];
    return { id: Number(row.id) };
  }
  async function updateReview(id, { bonus_paid }) {
    await db.query('UPDATE cleaner_google_reviews SET bonus_paid = $2 WHERE id = $1', [Number(id), !!bonus_paid]);
  }
  async function deleteReview(id) {
    await db.query('DELETE FROM cleaner_google_reviews WHERE id = $1', [Number(id)]);
  }

  async function status() {
    const s = await load();
    const last = (await db.query('SELECT status, error, taken_at FROM report_snapshots ORDER BY id DESC LIMIT 1')).rows[0];
    return { taken_at: s?.taken_at || null, running: !!running, last_error: last?.status === 'failed' ? last.error : null, covers_from: s?.from || null };
  }

  // Utilization (read-only): of cleaners' open hours from..to, how much is spoken for and how
  // much is left to book. Built from the planner's live copy (8 weeks ahead).
  async function utilization({ from, to, locations = null } = {}) {
    if (!schedule?.utilizationSource) throw Object.assign(new Error('The scheduling planner is not running'), { status: 409 });
    let src;
    try {
      src = await schedule.utilizationSource();
    } catch (err) {
      throw Object.assign(new Error(err.message), { status: err.status || 409 });
    }
    const maxTo = addDays(src.today, 55);
    const range = clampRange(src.today, from, to, maxTo);
    const facts = utilizationFacts({ today: src.today, cleaners: src.cleaners, visits: src.visits, holidays: src.holidays, unavailable: src.unavailable, locations });
    // Scheduling insights' own figures, for "Check the numbers".
    const { ov } = await plannerView(locations);
    let existing = null;
    if (ov) {
      const rows = ov.rows.filter((r) => r.assignable);
      const w4 = (k) => rows.reduce((m, r) => m + r.weeks.slice(0, 4).reduce((a, x) => a + x[k], 0), 0);
      existing = { capacity4: w4('capacity'), booked4: w4('booked'), unassigned_visits: ov.counts.unassigned_visits, tolerance: Math.max(0.5, rows.length * 4 * 0.05) };
    }
    return utilizationReport({ facts, ...range, maxTo, cfg: UTILIZATION, existing, takenAt: src.taken_at });
  }

  // The raw year of visits (for the Commercial area).
  const visitsSnapshot = () => need();
  return { sync, start, maybeRun, scheduling, utilization, cleaners, cleaner, status, visitsSnapshot, recordDrop, codeChange, dropsForChanges, addReview, updateReview, deleteReview, isRunning: () => !!running, mondayOf };
}
