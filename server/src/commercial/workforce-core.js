// Commercial workforce planning: pure functions over the scheduling planner's snapshot.
//
// UrbanMop is separating its cleaners into a Commercial team and a Residential team. Many
// Commercial visits (homemaking partners, hospital transition programs, offices) are still held
// by Residential cleaners. This module answers, for a week:
//   - which Commercial visits are held by cleaners outside the Commercial team, and which
//     Commercial cleaner could take each one (the weekly plan);
//   - which Commercial visits have no cleaner, and who is free nearby;
//   - how loaded each Commercial cleaner is;
//   - which standard slots are open, so partners (Carefor, OWCS) can place new clients.
//
// The rules come from the Commercial lead's planner (docs/commercial-workforce.md); here they
// run on live Launch27 data (hours, days off, every booking with its address) instead of CSV
// exports. Nothing here writes anywhere.
import { addDays, fitsDay, km, travelMinutes, weekday, nameMatches } from '../schedule/rules.js';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const dayIndex = (d) => (weekday(d) + 6) % 7; // 0 = Monday
export const ROAD_FACTOR = 1.3; // straight line -> road distance, as on the Routes page
const SLOT_BUFFER = 30; // minutes kept clear around an open slot (the new client's address isn't known yet)
const r1 = (x) => Math.round(x * 10) / 10;
const roadKm = (a, b) => {
  const d = km(a, b);
  return d == null ? null : d * ROAD_FACTOR;
};

export const DEFAULT_SETTINGS = {
  threshold: 0.5, // share of Commercial hours that suggests a cleaner belongs to the Commercial team
  transitionRule: true, // transition-program clients keep their cleaner until the program ends
  partner: {
    accounts: { Carefor: ['Carefor', 'Bruyère at Home', 'Queensway Carleton at Home', 'Montfort at Home'], OWCS: ['OWCS', 'OWCS GHP'] },
    showNames: false,
    showOwnAddresses: true,
    showOtherPartners: false,
    weeks: 4,
    days: [0, 1, 2, 3, 4],
    slots: [[540, 120], [690, 120], [840, 120]], // 9:00, 11:30, 2:00, two hours each
    contact: '',
  },
};

// ---------- accounts and categories ----------
export const CATEGORIES = ['Transition programs', 'Homemaking', 'Past temporary homemaking', 'EOPMG', 'Commercial accounts', 'Residential under Commercial', 'Other'];
/** The Commercial account and category of a planner visit. First rule that matches wins. */
export function classify(v) {
  const services = (v.services || []).join(' | ').toLowerCase();
  const names = `${v.account_name || ''} ${v.partner_name || ''}`.toLowerCase();
  if (v.partner_kind === 'after' || services.includes('past temporary')) return { category: 'Past temporary homemaking', account: v.customer || 'Client' };
  if (/going home program|\bghp\b/.test(`${names} ${services}`)) return { category: 'Transition programs', account: 'OWCS GHP' };
  if (v.partner_kind === 'program') return { category: 'Transition programs', account: v.partner_name || v.program || 'Program' };
  if (/mft\s*at\s*home|mftathome/.test(names)) return { category: 'Transition programs', account: 'Montfort at Home' };
  if (/qch\s*at\s*home|qchathome/.test(names)) return { category: 'Transition programs', account: 'Queensway Carleton at Home' };
  if (/bruy[eè]re\s*at\s*home|bruyereathome/.test(names)) return { category: 'Transition programs', account: 'Bruyère at Home' };
  if (v.partner_kind === 'homemaking') return { category: 'Homemaking', account: String(v.partner_name || 'Homemaking').replace(/\s+homemaking$/i, '') };
  if (/eopmg/.test(`${names} ${String(v.customer || '').toLowerCase()}`)) return { category: 'EOPMG', account: 'EOPMG' };
  if (v.partner_kind === 'company' || services.includes('commercial')) return { category: 'Commercial accounts', account: v.partner_name || v.customer || 'Account' };
  if (/bedroom|hourly/.test(services)) return { category: 'Residential under Commercial', account: v.customer || 'Client' };
  if (services.includes('homemaking')) return { category: 'Homemaking', account: 'Homemaking (program to confirm)' };
  return { category: 'Other', account: v.customer || 'Client' };
}

/** A visit is Commercial when it is booked at a Commercial location, or belongs to a homemaking partner or program. */
export const commercialTest = (locationIds) => {
  const locs = new Set((locationIds || []).map(Number));
  return (v) => locs.has(Number(v.location_id)) || v.partner_kind === 'homemaking' || v.partner_kind === 'program';
};

// ---------- who is on the Commercial team ----------
/**
 * Hours per cleaner over the last 8 weeks and everything upcoming: Commercial, Residential and
 * the Commercial share. Only cleaners who do some Commercial work (or are ticked) are listed.
 */
export function teamStats({ visits, cleaners, today, isCom, ticks = new Map(), lastDay = new Map(), threshold = 0.5 }) {
  const from = addDays(today, -56);
  const S = new Map();
  const get = (id) => S.get(id) || S.set(id, { com: 0, res: 0, upcoming: 0, locations: new Map(), accounts: new Set() }).get(id);
  for (const v of visits) {
    if (v.date < from) continue;
    const com = isCom(v);
    for (const id of v.team_ids) {
      const s = get(id);
      if (com) {
        s.com += v.duration;
        s.locations.set(v.location_id, (s.locations.get(v.location_id) || 0) + v.duration);
        s.accounts.add(classify(v).account);
        if (v.date >= today) s.upcoming++;
      } else s.res += v.duration;
    }
  }
  const rows = [];
  for (const c of cleaners) {
    const s = S.get(c.id);
    const ticked = ticks.has(c.id) ? ticks.get(c.id) : null;
    if (!(s?.com > 0) && ticked !== true) continue;
    const com = s?.com || 0;
    const res = s?.res || 0;
    const share = com + res ? com / (com + res) : 0;
    const suggested = share >= threshold;
    rows.push({
      id: c.id, name: c.name, status: c.status, assignable: !!c.assignable,
      commercial_hours: r1(com / 60), residential_hours: r1(res / 60), share: Math.round(share * 100) / 100,
      suggested, ticked, commercial: ticked ?? suggested,
      upcoming_commercial: s?.upcoming || 0, accounts: s ? s.accounts.size : 0,
      location_ids: s ? [...s.locations.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id) : [],
      has_hours: (c.availability || []).some((r) => !r.date && !r.dayoff && r.start_time && r.end_time),
      last_day: lastDay.get(c.id) || null,
    });
  }
  return rows.sort((a, b) => Number(b.commercial) - Number(a.commercial) || b.commercial_hours - a.commercial_hours);
}

// ---------- the weekly plan ----------
/**
 * ctx: { today, visits, cleaners, windowFor(cleaner, date), isCom(visit), team (teamStats rows),
 *        state: Map(seriesKey -> { status, assignee_id, ends_on }), settings, prefsFor(customerId) }
 */
export function planWeek(ctx, weekStart) {
  const { visits, cleaners, windowFor, isCom, team, state = new Map(), settings = DEFAULT_SETTINGS } = ctx;
  const weekEnd = addDays(weekStart, 6);
  const byId = new Map(cleaners.map((c) => [c.id, c]));
  const teamById = new Map(team.map((t) => [t.id, t]));
  const onTeam = (id) => !!teamById.get(id)?.commercial;
  const nameOf = (id) => byId.get(id)?.name || 'Unknown';
  const who = (id) => ({ id, name: nameOf(id) });

  // Series this week: the same client, weekday, time, length and rhythm.
  const series = new Map();
  const busy = new Map(); // `${cleanerId}|${date}` -> [{ start, end, lat, lng, key, type: C | R | plan, label }]
  const addBusy = (id, date, item) => {
    const k = `${id}|${date}`;
    if (!busy.has(k)) busy.set(k, []);
    busy.get(k).push(item);
  };
  for (const v of visits) {
    if (v.date < weekStart || v.date > weekEnd) continue;
    if (!isCom(v)) {
      for (const id of v.team_ids) addBusy(id, v.date, { start: v.start, end: v.end, lat: v.lat, lng: v.lng, key: v.key, type: 'R', label: 'Residential' });
      continue;
    }
    const key = `${v.customer_id}|${dayIndex(v.date)}|${v.start}|${v.duration}|${v.kind}`;
    if (!series.has(key)) {
      const c = classify(v);
      series.set(key, { key, client: v.customer, customer_id: v.customer_id, account: c.account, category: c.category, weekday: dayIndex(v.date), start: v.start, duration: v.duration, kind: v.kind, freq: v.freq, addr: v.addr, area: v.area, lat: v.lat, lng: v.lng, location_id: v.location_id, occ: [] });
    }
    const s = series.get(key);
    s.occ.push({ date: v.date, key: v.key, booking_id: v.id, cleaners: v.team_ids });
    for (const id of v.team_ids) addBusy(id, v.date, { start: v.start, end: v.end, lat: v.lat, lng: v.lng, key, type: 'C', label: c2label(s) });
  }
  const weekSeries = [...series.values()].sort((a, b) => a.occ[0].date.localeCompare(b.occ[0].date) || a.start - b.start);
  for (const s of weekSeries) {
    s.occ.sort((a, b) => a.date.localeCompare(b.date));
    s.holders = [...new Set(s.occ.flatMap((o) => o.cleaners))];
  }

  // Who has served each account (for "knows this account").
  const served = new Map();
  for (const v of visits) {
    if (!isCom(v)) continue;
    const a = classify(v).account;
    if (!served.has(a)) served.set(a, new Set());
    for (const id of v.team_ids) served.get(a).add(id);
  }
  const worksIn = (id, loc) => {
    const l = teamById.get(id)?.location_ids;
    return !l?.length || l.includes(loc); // no Commercial history = not restricted
  };

  const comTeam = team.filter((t) => t.commercial && byId.has(t.id));
  const cap = new Map();
  for (const t of comTeam) {
    const c = byId.get(t.id);
    let avail = 0;
    for (let i = 0; i < 7; i++) {
      const w = windowFor(c, addDays(weekStart, i));
      if (w) avail += w[1] - w[0];
    }
    cap.set(t.id, { id: t.id, name: t.name, avail, com: 0, res: 0, added: 0, has_hours: t.has_hours, last_day: t.last_day });
  }
  for (const [k, list] of busy) {
    const c = cap.get(Number(k.split('|')[0]));
    if (c) for (const x of list) c[x.type === 'R' ? 'res' : 'com'] += x.end - x.start;
  }

  const lastDayOf = (id) => teamById.get(id)?.last_day || null;
  const place = (s) => ({ lat: s.lat, lng: s.lng });
  /** Can this cleaner take every listed occurrence of the series? Uses the planner's own rules. */
  function feasible(id, s, occs = s.occ) {
    const c = byId.get(id);
    if (!c || !c.assignable || !worksIn(id, s.location_id)) return false;
    const prefs = ctx.prefsFor?.(s.customer_id);
    if (prefs?.avoid?.some((n) => nameMatches(c.name, n))) return false;
    if (prefs?.femaleOnly && c.gender !== 'F') return false;
    const last = lastDayOf(id);
    for (const o of occs) {
      if (last && o.date > last) return false;
      const fit = fitsDay({ window: windowFor(c, o.date), busy: busy.get(`${id}|${o.date}`) || [], start: s.start, duration: s.duration, place: place(s), transit: c.rules?.transit });
      if (!fit.ok) return false;
    }
    return true;
  }
  /** Extra road km a series adds to a cleaner's days: the detour between the visits before and after it. */
  function addedKm(id, s, occs = s.occ) {
    let total = 0;
    for (const o of occs) {
      const list = busy.get(`${id}|${o.date}`) || [];
      let prev = null;
      let next = null;
      for (const x of list) {
        if (x.end <= s.start && (!prev || x.end > prev.end)) prev = x;
        if (x.start >= s.start + s.duration && (!next || x.start < next.start)) next = x;
      }
      const a = prev ? roadKm(prev, s) : 0;
      const b = next ? roadKm(s, next) : 0;
      const ab = prev && next ? roadKm(prev, next) : 0;
      if (a == null || b == null || ab == null) return null;
      total += a + b - ab;
    }
    return r1(total);
  }
  const free = (id) => {
    const c = cap.get(id);
    return c.avail - c.com - c.res - c.added;
  };
  const reserve = (id, s) => {
    for (const o of s.occ) addBusy(id, o.date, { start: s.start, end: s.start + s.duration, lat: s.lat, lng: s.lng, key: s.key, type: 'plan', label: c2label(s) });
    if (cap.has(id)) cap.get(id).added += s.duration * s.occ.length;
  };

  const actions = [];
  const unassigned = [];
  // Pass 1: programs that stay, and moves someone already approved (they reserve their cleaner first).
  for (const s of weekSeries) {
    if (s.occ.some((o) => !o.cleaners.length)) unassigned.push(s);
    const holders = s.holders.filter((id) => !onTeam(id));
    if (!holders.length) continue;
    const st = state.get(s.key) || {};
    const a = { series: s, holders, state: st.status || 'proposed', end: st.ends_on || null, assignee: st.assignee_id || null, candidates: [], kind: '' };
    actions.push(a);
    if (settings.transitionRule && s.category === 'Transition programs' && (!a.end || a.end >= weekStart)) a.kind = 'stay';
    else if (a.assignee && (a.state === 'approved' || a.state === 'done') && cap.has(a.assignee)) {
      a.kind = 'move';
      a.pick = a.assignee;
      reserve(a.assignee, s);
    }
  }
  // Pass 2: everything else gets the best Commercial cleaner who can take it.
  for (const a of actions) {
    const s = a.series;
    if (a.kind === 'move') {
      a.candidates = [{ ...who(a.pick), added_km: null, served: !!served.get(s.account)?.has(a.pick) }];
      continue;
    }
    if (a.kind) continue;
    if (a.state === 'hold') {
      a.kind = 'hold';
      continue;
    }
    const able = comTeam.map((t) => t.id).filter((id) => feasible(id, s));
    const scored = able.map((id) => ({ ...who(id), added_km: addedKm(id, s), served: !!served.get(s.account)?.has(id), free: free(id) }));
    scored.sort((x, y) => Number(y.served) - Number(x.served) || (x.added_km ?? 1e9) - (y.added_km ?? 1e9) || y.free - x.free);
    a.candidates = scored.slice(0, 4).map(({ free: f, ...rest }) => ({ ...rest, free_hours: r1(f / 60) }));
    const pick = a.assignee && able.includes(a.assignee) ? a.assignee : scored[0]?.id;
    if (pick) {
      a.kind = 'move';
      a.pick = pick;
      reserve(pick, s);
    } else a.kind = 'nocover';
  }

  // Visits with no cleaner: Commercial cleaners who can take them, nearest first; otherwise
  // cleaners outside the team who already do Commercial work.
  const mixed = team.filter((t) => !t.commercial && byId.has(t.id)).map((t) => t.id);
  const nearest = (id, s, occs) => {
    let best = null;
    for (const o of occs) {
      for (const x of busy.get(`${id}|${o.date}`) || []) {
        const d = roadKm(x, s);
        if (d == null) continue;
        if (!best || d < best.km) best = { km: r1(d), before: x.end <= s.start, time: x.end <= s.start ? x.end : x.start, label: x.type === 'R' ? 'a Residential job' : x.label };
      }
    }
    return best;
  };
  const unassignedOut = unassigned.map((s) => {
    const occs = s.occ.filter((o) => !o.cleaners.length);
    const rank = (pool) => pool.filter((id) => feasible(id, s, occs)).map((id) => ({ ...who(id), near: nearest(id, s, occs) })).sort((x, y) => (x.near?.km ?? 1e9) - (y.near?.km ?? 1e9)).slice(0, 3);
    const com = rank(comTeam.map((t) => t.id));
    return { ...seriesOut(s), dates: occs.map((o) => o.date), visit_keys: occs.map((o) => o.key), commercial: com, others: com.length ? [] : rank(mixed) };
  });

  // Also this week.
  const off = []; // a Commercial visit booked outside its cleaner's hours or on a day off
  const clashes = [];
  const tight = [];
  let resOnCom = 0;
  let resOnComMin = 0;
  for (const [k, list] of busy) {
    const [idStr, date] = k.split('|');
    const id = Number(idStr);
    const c = byId.get(id);
    const real = list.filter((x) => x.type !== 'plan').sort((a, b) => a.start - b.start);
    const hasCom = real.some((x) => x.type === 'C');
    if (onTeam(id)) for (const x of real) if (x.type === 'R') { resOnCom++; resOnComMin += x.end - x.start; }
    if (!c || !hasCom) continue;
    const w = windowFor(c, date);
    for (const x of real) {
      if (x.type !== 'C') continue;
      if (!w) off.push({ cleaner: who(id), date, start: x.start, end: x.end, label: x.label, why: 'Day off' });
      else if (x.start < w[0] || x.end > w[1]) off.push({ cleaner: who(id), date, start: x.start, end: x.end, label: x.label, why: 'Outside their hours' });
    }
    for (let i = 1; i < real.length; i++) {
      const a = real[i - 1];
      const b = real[i];
      if (a.type !== 'C' && b.type !== 'C') continue;
      if (b.start < a.end) clashes.push({ cleaner: who(id), date, start: b.start, a: a.label, b: b.label });
      else if (onTeam(id)) {
        const need = travelMinutes(km(a, b), c.rules?.transit);
        if (km(a, b) != null && km(a, b) > 0.05 && b.start - a.end < need) tight.push({ cleaner: who(id), date, from: a.label, to: b.label, gap: b.start - a.end, need, km: r1(roadKm(a, b)) });
      }
    }
  }
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.start - b.start;
  off.sort(byDate);
  clashes.sort(byDate);

  // How many more Commercial cleaners the uncovered visits would need at once, per weekday.
  const peak = {};
  let nocoverMin = 0;
  const points = {};
  for (const a of actions) {
    if (a.kind !== 'nocover') continue;
    for (const o of a.series.occ) {
      const d = DAYS[dayIndex(o.date)];
      (points[d] = points[d] || []).push([a.series.start, 1], [a.series.start + a.series.duration, -1]);
      nocoverMin += a.series.duration;
    }
  }
  for (const [d, pts] of Object.entries(points)) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let c = 0;
    let m = 0;
    for (const p of pts) m = Math.max(m, (c += p[1]));
    peak[d] = m;
  }

  // Road km per Commercial cleaner, before and after the planned moves.
  const movedOut = new Set(actions.filter((a) => a.kind === 'move').flatMap((a) => a.holders.map((h) => `${h}|${a.series.key}`)));
  const dayKm = (id, date, planned) => {
    const stops = (busy.get(`${id}|${date}`) || []).filter((x) => (planned ? !(x.type === 'C' && movedOut.has(`${id}|${x.key}`)) : x.type !== 'plan')).sort((a, b) => a.start - b.start);
    let total = 0;
    for (let i = 1; i < stops.length; i++) total += roadKm(stops[i - 1], stops[i]) || 0;
    return total;
  };
  const load = [...cap.values()].map((c) => {
    let before = 0;
    let after = 0;
    for (let i = 0; i < 7; i++) {
      before += dayKm(c.id, addDays(weekStart, i), false);
      after += dayKm(c.id, addDays(weekStart, i), true);
    }
    return { id: c.id, name: c.name, available_hours: r1(c.avail / 60), commercial_hours: r1(c.com / 60), residential_hours: r1(c.res / 60), planned_hours: r1(c.added / 60), km_now: Math.round(before), km_planned: Math.round(after), has_hours: c.has_hours, last_day: c.last_day };
  });

  // The week board: Commercial cleaners, plus anyone else holding a Commercial visit this week.
  const kindOf = new Map(); // `${holderId}|${seriesKey}` -> move | stay | nocover | hold
  for (const a of actions) for (const h of a.holders) kindOf.set(`${h}|${a.series.key}`, a.kind);
  const boardIds = [...new Set([...comTeam.map((t) => t.id), ...actions.flatMap((a) => a.holders)])];
  const board = boardIds.map((id) => {
    const c = byId.get(id);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const w = c ? windowFor(c, date) : null;
      const blocks = (busy.get(`${id}|${date}`) || []).map((x) => {
        let type = x.type === 'R' ? 'res' : x.type === 'plan' ? 'in' : 'com';
        if (x.type === 'C') {
          const k = kindOf.get(`${id}|${x.key}`);
          if (k === 'move') type = 'out';
          else if (k === 'stay') type = 'stay';
          else if (k === 'nocover') type = 'nocover';
          if (!w || x.start < w[0] || x.end > w[1]) type = 'off';
        }
        return { start: x.start, end: x.end, type, label: x.label };
      }).sort((a, b) => a.start - b.start);
      days.push({ date, window: w, blocks });
    }
    return { id, name: nameOf(id), commercial: onTeam(id), days };
  });
  const noCleaner = unassignedOut.flatMap((u) => u.dates.map((date) => ({ date, start: u.start, end: u.start + u.duration, label: `${u.account} · ${u.client}`, try: u.commercial[0] ? `${u.commercial[0].name}${u.commercial[0].near ? ` (${u.commercial[0].near.km} km)` : ''}` : null })));

  let visitsN = 0;
  let comMin = 0;
  let onTeamMin = 0;
  for (const s of weekSeries) {
    for (const o of s.occ) {
      visitsN++;
      comMin += s.duration * Math.max(1, o.cleaners.length);
      if (o.cleaners.length && o.cleaners.every(onTeam)) onTeamMin += s.duration * o.cleaners.length;
    }
  }

  return {
    week: weekStart, week_end: weekEnd,
    totals: {
      visits: visitsN, hours: r1(comMin / 60), on_team_share: comMin ? Math.round((onTeamMin / comMin) * 100) / 100 : 0,
      move: actions.filter((a) => a.kind === 'move').length, nocover: actions.filter((a) => a.kind === 'nocover').length,
      stay: actions.filter((a) => a.kind === 'stay').length, hold: actions.filter((a) => a.kind === 'hold').length,
      unassigned: unassignedOut.reduce((n, u) => n + u.dates.length, 0), nocover_hours: r1(nocoverMin / 60),
      team: comTeam.length, residential_on_team: resOnCom, residential_on_team_hours: r1(resOnComMin / 60),
    },
    actions: actions.map((a) => ({ ...seriesOut(a.series), dates: a.series.occ.map((o) => o.date), kind: a.kind, state: a.state, end: a.end, holders: a.holders.map(who), pick: a.pick ? a.candidates.find((c) => c.id === a.pick) || who(a.pick) : null, candidates: a.candidates })),
    unassigned: unassignedOut,
    load, peak, off, clashes, tight, board, no_cleaner: noCleaner,
    _busy: busy, _series: weekSeries, // for computeSlots; dropped before sending
  };
}
const c2label = (s) => (s.account === s.client ? s.client : `${s.account} · ${s.client}`);
const seriesOut = (s) => ({ key: s.key, client: s.client, account: s.account, category: s.category, weekday: s.weekday, start: s.start, duration: s.duration, rhythm: s.kind, addr: s.addr, area: s.area, location_id: s.location_id });

// ---------- open slots ----------
/**
 * For each Commercial cleaner, weekday and standard slot, every week in the horizon: are they
 * working, before their last day, and clear of every other visit (and planned move) by 30
 * minutes? Remembers the visits just before and after, for distance.
 */
export function computeSlots(ctx, { startWeek, weeks, days, slots, areaOf = () => 'O' }) {
  const { cleaners, windowFor, team, today } = ctx;
  const byId = new Map(cleaners.map((c) => [c.id, c]));
  const weekStarts = Array.from({ length: weeks }, (_, i) => addDays(startWeek, 7 * i));
  const plans = weekStarts.map((w) => planWeek(ctx, w));
  const info = new Map();
  for (const p of plans) for (const s of p._series) info.set(s.key, s);
  const options = [];
  for (const t of team.filter((x) => x.commercial && byId.has(x.id)).sort((a, b) => a.name.localeCompare(b.name))) {
    const c = byId.get(t.id);
    for (const d of days) {
      slots.forEach(([st, len], si) => {
        const en = st + len;
        const rows = weekStarts.map((w, wi) => {
          const date = addDays(w, d);
          const win = windowFor(c, date);
          let why = '';
          if (date < today) why = 'past';
          else if (!c.assignable) why = 'not scheduled';
          else if (!win || st < win[0] || en > win[1]) why = 'not working';
          else if (t.last_day && date > t.last_day) why = 'left';
          let prev = null;
          let next = null;
          if (!why) {
            for (const x of plans[wi]._busy.get(`${t.id}|${date}`) || []) {
              if (x.start < en + SLOT_BUFFER && st - SLOT_BUFFER < x.end) { why = 'booked'; break; }
              if (x.end <= st && (!prev || x.end > prev.end)) prev = x;
              if (x.start >= en && (!next || x.start < next.start)) next = x;
            }
          }
          const nb = (x, end) => {
            if (!x) return null;
            const s = x.type === 'R' ? null : info.get(x.key);
            return { t: end ? x.end : x.start, lat: x.lat, lng: x.lng, kind: x.type === 'R' ? 'R' : 'C', account: s?.account || '', addr: s ? [s.addr, s.area].filter(Boolean).join(', ') : '' };
          };
          return { date, free: !why, why, prev: why ? null : nb(prev, true), next: why ? null : nb(next, false) };
        });
        options.push({ cleaner_id: t.id, cleaner: t.name, area: areaOf(t.location_ids?.[0]), day: d, slot: si, weeks: rows });
      });
    }
  }
  return { weeks: weekStarts, days, slots, options };
}

/**
 * Slots for a new client at a place: nearest existing visit first, then fewest weeks already
 * booked, then no tight travel. freq: 1 weekly, 2 every two weeks, 0 one visit.
 */
export function suggestSlots(slotData, { place = null, area = null, freq = 1, day = null, limit = 8 } = {}) {
  const W = slotData.weeks.length;
  const out = [];
  for (const o of slotData.options) {
    if (day != null && o.day !== day) continue;
    if (area && o.area !== area) continue;
    const [st, len] = slotData.slots[o.slot];
    const starts = freq === 0 ? o.weeks.map((_, i) => i) : freq === 2 ? [0, 1] : [0];
    for (const first of starts) {
      const wk = [];
      if (freq === 0) wk.push(first);
      else for (let i = first; i < W; i += freq) wk.push(i);
      if (!o.weeks[wk[0]]?.free) continue; // the first visit must be free
      const freeWeeks = wk.filter((i) => o.weeks[i].free);
      let best = null;
      let tight = false;
      for (const i of freeWeeks) {
        const w = o.weeks[i];
        for (const [x, before] of [[w.prev, true], [w.next, false]]) {
          if (!x || !place) continue;
          const d = roadKm(x, place);
          if (d == null) continue;
          if (!best || d < best.km) best = { km: r1(d), before, time: x.t, kind: x.kind, account: x.account, addr: x.addr };
          const need = travelMinutes(km(x, place));
          if (before ? st - x.t < need : x.t - (st + len) < need) tight = true;
        }
      }
      const missing = wk.filter((i) => !o.weeks[i].free).map((i) => o.weeks[i].date);
      out.push({ cleaner_id: o.cleaner_id, cleaner: o.cleaner, area: o.area, day: o.day, start: st, duration: len, first: o.weeks[wk[0]].date, freq, near: best, tight, missing, score: (best ? best.km : 60) + missing.length * 6 + (tight ? 8 : 0) });
    }
  }
  out.sort((a, b) => a.score - b.score || a.first.localeCompare(b.first));
  const seen = new Set();
  const kept = [];
  for (const c of out) {
    const k = `${c.day}|${c.start}|${c.first}|${c.cleaner_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(c);
  }
  return kept.slice(0, limit);
}

/**
 * What one partner's file may contain. Only fields the settings allow are copied; everything
 * else is never written into the file (a hidden setting is absence of data, not styling).
 * Places are reduced to postal areas (fsaOf) before they leave the app.
 */
export function partnerSnapshot(slotData, partner, cfg) {
  const own = new Set(cfg.accounts?.[partner] || []);
  const letters = new Map();
  const label = (o) => {
    if (cfg.showNames) return o.cleaner;
    if (!letters.has(o.cleaner_id)) letters.set(o.cleaner_id, `Cleaner ${String.fromCharCode(65 + (letters.size % 26))}${letters.size >= 26 ? Math.floor(letters.size / 26) : ''}`);
    return letters.get(o.cleaner_id);
  };
  const nb = (x) => {
    if (!x) return null;
    const o = { t: x.t, fsa: cfg.fsaOf?.(x) || '' };
    const mine = x.kind === 'C' && own.has(x.account);
    if (mine && cfg.showOwnAddresses) Object.assign(o, { mine: 1, addr: x.addr });
    else if (!mine && x.kind === 'C' && cfg.showOtherPartners) Object.assign(o, { addr: x.addr, acct: x.account });
    return o;
  };
  const options = slotData.options
    .map((op) => ({ c: label(op), l: op.area, d: op.day, s: op.slot, w: op.weeks.map((r) => (r.free ? { f: 1, p: nb(r.prev), n: nb(r.next) } : { f: 0 })) }))
    .filter((op) => op.w.some((r) => r.f));
  return { v: 1, partner, generated: cfg.generated, source: 'UrbanMop', weeks: slotData.weeks, slots: slotData.slots, days: slotData.days, showNames: !!cfg.showNames, contact: cfg.contact || '', options };
}
