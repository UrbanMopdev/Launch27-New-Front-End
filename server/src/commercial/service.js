// Commercial area: organizations (partners) and hospital transition programs.
// Reads what the app already has: a year of past visits (reports) and the booked visits ahead
// (scheduling planner). Nothing is stored here and nothing is written to Launch27.
import { EPISODE_GAP_DAYS, EXPECTED_PER_MONTH, PROGRAMS, PROGRAM_PLAN, planStatus } from './partners.js';
import { addDays, mondayOf } from '../schedule/rules.js';

const PERIOD_DAYS = { '4w': 28, '13w': 91, '12m': 365 };
const KIND_LABEL = { homemaking: 'Ongoing homemaking', program: 'Hospital transition program', after: 'After a program', company: 'Organization', account: 'Commercial account' };
const RHYTHM = { weekly: 'Weekly', bi: 'Every 2 weeks', tri: 'Every 3 weeks', monthly: 'Monthly', one: 'One-time' };
const round = (x) => Math.round(x * 100) / 100;
const top = (counter) => [...counter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const inc = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

export function createCommercial({ reports, schedule, now = () => Date.now() }) {
  const today = () => new Date(now()).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

  async function load() {
    const past = await reports.visitsSnapshot(); // throws 409 until reports are built
    const s = await schedule._load().catch(() => null);
    const names = s ? s.byId : new Map();
    const future = (s?.future || []).map((v) => ({ ...v, teams: v.team_ids.map((id) => ({ id, name: names.get(id)?.name || 'Cleaner' })) }));
    return { past: past.visits, future, today: today() };
  }

  // A visit is Commercial when it belongs to a partner, or is booked at a Commercial location.
  const inScope = (locs) => (v) => (v.partner && v.partner_kind !== 'company') || v.partner_kind === 'program' || v.program || (locs ? locs.has(Number(v.location_id)) : false);
  const groupOf = (v) => (v.partner ? { key: v.partner, name: v.partner_name, kind: v.partner_kind || (v.program ? 'program' : 'company') } : { key: `acct-${v.account_id ?? v.customer_id}`, name: v.customer, kind: 'account' });

  async function organizations({ period = '13w', locations = null } = {}) {
    const { past, future, today: t } = await load();
    const days = PERIOD_DAYS[period] || 91;
    const from = addDays(t, -days);
    const prevFrom = addDays(from, -days);
    const locs = locations?.length ? new Set(locations.map(Number)) : null;
    const scope = inScope(locs);
    const orgs = new Map();
    const get = (v) => {
      const g = groupOf(v);
      if (!orgs.has(g.key)) orgs.set(g.key, { ...g, clients: new Set(), visits: 0, revenue: 0, prev: 0, rhythm: new Map(), cleanersByClient: new Map(), next: null, upcoming: 0, unassigned: 0 });
      return orgs.get(g.key);
    };
    for (const v of past) {
      if (!scope(v) || v.date < prevFrom) continue;
      const o = get(v);
      if (v.date < from) { o.prev += v.revenue; continue; }
      o.clients.add(v.customer_id);
      o.visits++;
      o.revenue += v.revenue;
      inc(o.rhythm, v.kind);
      const set = o.cleanersByClient.get(v.customer_id) || new Set();
      for (const tm of v.teams) set.add(tm.id);
      o.cleanersByClient.set(v.customer_id, set);
    }
    const soon = addDays(t, 28);
    for (const v of future) {
      if (!scope(v)) continue;
      const o = get(v);
      o.upcoming++;
      if (!o.next || v.date < o.next) o.next = v.date;
      if (!v.team_ids.length && v.date <= soon) o.unassigned++;
    }
    const total = [...orgs.values()].reduce((a, o) => a + o.revenue, 0);
    const rows = [...orgs.values()].filter((o) => o.visits || o.upcoming).map((o) => {
      const withCleaner = [...o.cleanersByClient.values()].filter((x) => x.size);
      return {
        key: o.key, name: o.name, kind: o.kind, kind_label: KIND_LABEL[o.kind] || 'Organization',
        clients: o.clients.size, visits: o.visits, revenue: round(o.revenue), prev_revenue: round(o.prev),
        trend: o.prev > 0 ? round((o.revenue - o.prev) / o.prev) : o.revenue > 0 ? null : 0,
        rhythm: RHYTHM[top(o.rhythm)] || '—',
        same_cleaner: withCleaner.length ? round(withCleaner.filter((x) => x.size === 1).length / withCleaner.length) : null,
        share: total ? round(o.revenue / total) : 0,
        next: o.next, upcoming: o.upcoming, unassigned_28d: o.unassigned,
      };
    }).sort((a, b) => b.revenue - a.revenue || b.upcoming - a.upcoming);
    const partner = rows.filter((r) => r.kind === 'homemaking' || r.kind === 'program');
    return {
      today: t, period, from,
      totals: {
        organizations: rows.filter((r) => r.visits).length,
        clients: rows.reduce((a, r) => a + r.clients, 0),
        visits: rows.reduce((a, r) => a + r.visits, 0),
        revenue: round(total),
        partner_share: total ? round(partner.reduce((a, r) => a + r.revenue, 0) / total) : 0,
        unassigned_28d: rows.reduce((a, r) => a + r.unassigned_28d, 0),
      },
      rows,
    };
  }

  async function organization(key, { period = '13w', locations = null } = {}) {
    const { past, future, today: t } = await load();
    const days = PERIOD_DAYS[period] || 91;
    const from = addDays(t, -days);
    const scope = inScope(locations?.length ? new Set(locations.map(Number)) : null);
    const mine = (v) => scope(v) && groupOf(v).key === key;
    const pv = past.filter(mine);
    const fv = future.filter(mine);
    if (!pv.length && !fv.length) throw Object.assign(new Error('No such organization'), { status: 404 });
    const g = groupOf(pv[0] || fv[0]);
    const clients = new Map();
    const client = (v) => {
      if (!clients.has(v.customer_id)) clients.set(v.customer_id, { id: v.customer_id, name: v.customer, addr: v.addr || null, visits: 0, revenue: 0, rhythm: new Map(), cleaners: new Map(), last: null, next: null });
      return clients.get(v.customer_id);
    };
    const weekStart = mondayOf(addDays(t, -7 * 25));
    const weeks = Array.from({ length: 26 }, (_, i) => ({ week: addDays(weekStart, i * 7), visits: 0, revenue: 0 }));
    let visits = 0;
    let revenue = 0;
    for (const v of pv) {
      const wi = Math.floor((Date.parse(v.date) - Date.parse(weekStart)) / (7 * 86_400_000));
      if (wi >= 0 && wi < 26) { weeks[wi].visits++; weeks[wi].revenue = round(weeks[wi].revenue + v.revenue); }
      if (v.date < from) continue;
      const c = client(v);
      c.visits++; c.revenue = round(c.revenue + v.revenue);
      inc(c.rhythm, v.kind);
      for (const tm of v.teams) inc(c.cleaners, tm.name);
      if (!c.last || v.date > c.last) c.last = v.date;
      visits++; revenue += v.revenue;
    }
    for (const v of fv) {
      const c = client(v);
      if (!c.next || v.date < c.next.date) c.next = { date: v.date, time: v.start, cleaner: v.teams[0]?.name || null };
      inc(c.rhythm, v.kind, 0.01);
    }
    const rows = [...clients.values()].map((c) => ({ id: c.id, name: c.name, addr: c.addr, visits: c.visits, revenue: c.revenue, rhythm: RHYTHM[top(c.rhythm)] || '—', cleaner: top(c.cleaners), last: c.last, next: c.next })).sort((a, b) => b.visits - a.visits || String(a.name).localeCompare(String(b.name)));
    return {
      today: t, period, from, key: g.key, name: g.name, kind: g.kind, kind_label: KIND_LABEL[g.kind] || 'Organization', program: (pv[0] || fv[0]).program || null,
      stats: { visits, revenue: round(revenue), clients: rows.filter((r) => r.visits).length, booked_ahead: fv.length, avg: visits ? round(revenue / visits) : null, unassigned_28d: fv.filter((v) => !v.team_ids.length && v.date <= addDays(t, 28)).length },
      weeks, clients: rows,
    };
  }

  // Hospital transition programs: every patient's episode against the 4/2/1 plan.
  async function programs() {
    const { past, future, today: t } = await load();
    const byPatient = new Map(); // `${program}|${client}` -> { dates, visits }
    for (const v of [...past, ...future]) {
      if (!v.program) continue;
      const k = `${v.program}|${v.customer_id}`;
      if (!byPatient.has(k)) byPatient.set(k, { program: v.program, client: v.customer_id, name: v.customer, addr: v.addr, visits: [] });
      byPatient.get(k).visits.push(v);
    }
    const out = new Map();
    const prog = (code) => {
      if (!out.has(code)) out.set(code, { code, name: PROGRAMS[code]?.name || code, org: PROGRAMS[code]?.org || null, expected_per_month: EXPECTED_PER_MONTH[code] ?? null, patients: [], starts: new Map() });
      return out.get(code);
    };
    for (const p of byPatient.values()) {
      const vs = p.visits.sort((a, b) => a.date.localeCompare(b.date));
      // Split into episodes when the same address comes back after a long gap.
      const episodes = [];
      for (const v of vs) {
        const cur = episodes.at(-1);
        if (!cur || (Date.parse(v.date) - Date.parse(cur.at(-1).date)) / 86_400_000 > EPISODE_GAP_DAYS) episodes.push([v]);
        else if (cur.at(-1).date !== v.date) cur.push(v);
      }
      for (const ep of episodes) {
        const dates = ep.map((v) => v.date);
        const st = planStatus(dates, t);
        const last = [...ep].reverse().find((v) => v.date <= t);
        const nextBooked = ep.find((v) => v.date > t);
        const pr = prog(p.program);
        inc(pr.starts, dates[0].slice(0, 7));
        pr.patients.push({
          client: p.client, name: p.name, addr: p.addr, first: dates[0], last_visit: last?.date || null, ...st,
          next_booked: nextBooked ? { date: nextBooked.date, time: nextBooked.start, cleaner: nextBooked.teams?.[0]?.name || null } : null,
          cleaner: (last || ep[0]).teams?.[0]?.name || null,
        });
      }
    }
    const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(`${t.slice(0, 7)}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 5 + i); return d.toISOString().slice(0, 7); });
    const list = [...out.values()].map((pr) => {
      const active = pr.patients.filter((x) => x.state === 'active');
      const finishedRecent = pr.patients.filter((x) => x.state !== 'active' && x.last_visit && x.last_visit >= addDays(t, -60));
      const closed = pr.patients.filter((x) => x.state !== 'active');
      return {
        code: pr.code, name: pr.name, org: pr.org, expected_per_month: pr.expected_per_month,
        active: active.length,
        stages: { weekly: active.filter((x) => x.stage === 'weekly').length, biweekly: active.filter((x) => x.stage === 'biweekly').length, monthly: active.filter((x) => x.stage === 'monthly').length },
        off_plan: active.filter((x) => x.flags.length).length,
        unbooked: active.filter((x) => x.unbooked).length,
        completed_share: closed.length ? round(closed.filter((x) => x.visits >= PROGRAM_PLAN.length && !x.flags.some((f) => f.past)).length / closed.length) : null,
        typical_visits: closed.length ? top(closed.reduce((m, x) => inc(m, x.visits) && m, new Map())) : null,
        new_by_month: months.map((m) => ({ month: m, patients: pr.starts.get(m) || 0 })),
        patients: [...active, ...finishedRecent].sort((a, b) => Number(b.unbooked) - Number(a.unbooked) || b.flags.length - a.flags.length || String(a.next_planned || '9').localeCompare(String(b.next_planned || '9'))),
      };
    }).sort((a, b) => b.active - a.active);
    return { today: t, plan: PROGRAM_PLAN, programs: list };
  }

  return { organizations, organization, programs };
}
