// Headroom: how much room is left in cleaners' availability once the booked work is placed.
//
//   Raw headroom h       = usable availability − assigned h − unassigned h − h on cleaners not taking bookings
//   Adjusted headroom h  = raw − travel buffer − fragments
//   Headroom %           = headroom h ÷ usable availability
//
// Pure calculation over the planner's saved copy of Launch27 (no fetching, no writes).
// Usable availability = each cleaner's hours in Launch27 (weekly hours, or that date's own hours
// when set), minus days off set in Launch27 or marked unavailable in this app, minus company
// closed dates (unless the cleaner has their own hours set for that date), Monday–Saturday only.
import { addDays, areaOf, km, mondayOf, toMinutes, travelMinutes, weekday, workingWindow } from '../schedule/rules.js';
import { HEADROOM } from './headroom-config.js';

const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const ratio = (a, b) => (b > 0 ? a / b : null);

// ---------- intervals (minutes since midnight) ----------
function merge(list) {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const clip = (list, [w0, w1]) => list.map(([a, b]) => [Math.max(a, w0), Math.min(b, w1)]).filter(([a, b]) => b > a);
const total = (list) => merge(list).reduce((m, [a, b]) => m + (b - a), 0);
// Free stretches of the window once the blocks are taken out.
function freeGaps(window, blocks) {
  const gaps = [];
  let t = window[0];
  for (const [a, b] of merge(clip(blocks, window))) {
    if (a > t) gaps.push([t, a]);
    t = Math.max(t, b);
  }
  if (window[1] > t) gaps.push([t, window[1]]);
  return gaps;
}

export function statusOf(p, cfg = HEADROOM) {
  if (p == null) return null;
  return p <= cfg.redAt ? 'red' : p <= cfg.amberAt ? 'amber' : 'green';
}

// The dates of the window: week 1 runs from today to Sunday (as on Scheduling insights).
export function windowDates(today, weeks) {
  const start = mondayOf(today);
  const end = addDays(start, weeks * 7 - 1);
  const out = [];
  for (let d = today; d <= end; d = addDays(d, 1)) out.push(d);
  return { from: today, to: end, dates: out };
}

/**
 * Build the per-day facts every figure is summed from.
 * input: { today, cleaners, visits, holidays, unavailable: Map(id -> Set(dates)), locations, cfg }
 *   cleaners: planner cleaners ({ id, name, area, assignable, location_ids, availability, rules })
 *   visits:   planner visits from today on ({ key, date, start, end, duration, team_ids, team_hours, location_id, customer_id, kind, lat, lng })
 *   holidays: company closed dates ({ date, start_time, end_time, location_id })
 */
export function headroomFacts({ today, cleaners, visits, holidays = [], unavailable = new Map(), locations = null, cfg = HEADROOM, until }) {
  const brandIds = Array.isArray(locations) && locations.length ? new Set(locations.map(Number)) : null;
  const inBrand = (v) => !brandIds || brandIds.has(Number(v.location_id));
  const cleanerInBrand = (c) => !brandIds || !c.location_ids?.length || c.location_ids.some((id) => brandIds.has(Number(id)));
  const operating = new Set(cfg.operatingDays);
  // One leg of travel, in minutes (the planner's model; fallback when a pin is missing).
  const leg = (a, b, transit) => {
    const d = km(a, b);
    return d == null ? cfg.travelFallbackMinutes : travelMinutes(d, transit);
  };
  const legs = []; // every upcoming leg between two visits or home, to price unassigned visits
  const fragMin = cfg.fragmentMinHours * 60;
  // Through the trend's last week, or the last visit in the copy if later (so every unassigned
  // visit the planner counts is accounted for in the reconciliation).
  const lastVisit = visits.reduce((m, v) => (v.date > m ? v.date : m), today);
  const trendEnd = addDays(mondayOf(today), cfg.trendWeeks * 7 - 1);
  const end = until || (lastVisit > trendEnd ? lastVisit : trendEnd);
  const weekOf = (d) => mondayOf(d);

  const byId = new Map(cleaners.map((c) => [c.id, c]));
  // The cleaners whose availability counts: taking bookings, in the viewed brand.
  const taking = cleaners.filter((c) => c.assignable && cleanerInBrand(c));
  const takingIds = new Set(taking.map((c) => c.id));

  const future = visits.filter((v) => v.date >= today && v.date <= end);
  const busy = new Map(); // `${id}|${date}` -> visits
  for (const v of future) for (const id of v.team_ids) {
    const k = `${id}|${v.date}`;
    if (!busy.has(k)) busy.set(k, []);
    busy.get(k).push(v);
  }
  const share = (v, id) => (v.team_hours?.[id] ? v.team_hours[id] * 60 : v.duration / Math.max(v.team_ids.length, 1));

  const closedFor = (c, d) => holidays
    .filter((h) => String(h.date).slice(0, 10) === d && (h.location_id == null || !c.location_ids?.length || c.location_ids.map(Number).includes(Number(h.location_id))))
    .map((h) => [h.start_time ? toMinutes(h.start_time) : 0, h.end_time ? toMinutes(h.end_time) : 24 * 60])
    .map(([a, b]) => (b > a ? [a, b] : [0, 24 * 60]));
  const ownHoursOn = (c, d) => (c.availability || []).some((r) => r.date && String(r.date).slice(0, 10) === d && !r.dayoff && r.start_time && r.end_time);

  const days = []; // one per taking cleaner per date
  for (let d = today; d <= end; d = addDays(d, 1)) {
    const sunday = !operating.has(weekday(d));
    for (const c of taking) {
      const w = workingWindow(c.availability, d, unavailable.get(c.id));
      const list = busy.get(`${c.id}|${d}`) || [];
      const mine = list.filter(inBrand);
      const other = list.filter((v) => !inBrand(v));
      const base = w ? w[1] - w[0] : 0;
      // Company closed date: not available, unless this cleaner has their own hours set that day.
      const closed = w && !ownHoursOn(c, d) ? clip(closedFor(c, d), w) : [];
      const otherBlocks = w ? clip(other.map((v) => [v.start, v.end]), w) : [];
      const closedMin = total(closed);
      const otherMin = total([...closed, ...otherBlocks]) - closedMin;
      const avail = Math.max(base - closedMin - otherMin, 0);
      const assigned = mine.reduce((m, v) => m + share(v, c.id), 0);
      const otherBooked = other.reduce((m, v) => m + share(v, c.id), 0);
      // Travel along the day's route: home → each visit in time order → home. Visits for the
      // other brand are stops on the route too, but only legs into this brand's visits (and the
      // drive home after one) count against this brand.
      const transit = !!c.rules?.transit;
      const home = { lat: c.lat, lng: c.lng };
      const route = [...list].sort((a, b) => a.start - b.start);
      let travel = 0;
      const travelBlocks = [];
      let at = home;
      for (const v of route) {
        const m = leg(at, v, transit);
        if (inBrand(v)) {
          travel += m;
          travelBlocks.push([v.start - m, v.start]);
        }
        legs.push(m);
        at = v;
      }
      const last = route[route.length - 1];
      if (last && cfg.travelReturnHome) {
        const m = leg(last, home, transit);
        if (inBrand(last)) {
          travel += m;
          travelBlocks.push([last.end, last.end + m]);
        }
      }
      // Fragments: open stretches too short for a booking, after visits and their travel.
      let frag = 0;
      if (w) {
        const blocks = [...closed, ...otherBlocks, ...mine.map((v) => [v.start, v.end]), ...travelBlocks];
        for (const [a, b] of freeGaps(w, blocks)) if (b - a < fragMin) frag += b - a;
      }
      days.push({ d, wk: weekOf(d), sunday, cid: c.id, area: c.area || 'Unknown', base, closed: closedMin, other: otherMin, avail, assigned, otherBooked, travel, frag, visits: mine.length });
    }
  }

  // Visits not on a taking cleaner: unassigned, or on a cleaner not taking bookings (on hold, etc.).
  const loose = [];
  const customers = [];
  for (const v of future) {
    const sunday = !operating.has(weekday(v.date));
    const brand = inBrand(v);
    const addrArea = areaOf({ lat: v.lat, lng: v.lng });
    if (brand && v.customer_id != null) customers.push({ d: v.date, wk: weekOf(v.date), sunday, customer: v.customer_id, recurring: v.kind !== 'one', area: addrArea });
    if (!v.team_ids.length) {
      loose.push({ kind: 'unassigned', d: v.date, wk: weekOf(v.date), sunday, brand, area: addrArea, hours: v.duration, travel: 0, key: v.key });
      continue;
    }
    if (!brand) continue;
    for (const id of v.team_ids) {
      if (takingIds.has(id)) continue;
      const c = byId.get(id);
      loose.push({ kind: 'not_taking', d: v.date, wk: weekOf(v.date), sunday, brand, area: c?.area || addrArea, hours: share(v, id), travel: 0, cid: id, key: v.key });
    }
  }
  // Visits not on a taking cleaner have no route of their own: one average leg each.
  const avgLeg = legs.length ? legs.reduce((a, b) => a + b, 0) / legs.length : cfg.travelFallbackMinutes;
  for (const x of loose) x.travel = avgLeg;
  return { days, loose, customers, taking, today, end, avg_leg_min: avgLeg };
}

// Sum the facts for a set of dates (and optionally one area).
function sum(facts, inRange, area = null) {
  const days = facts.days.filter((x) => !x.sunday && inRange(x.d) && (!area || x.area === area));
  const loose = facts.loose.filter((x) => !x.sunday && x.brand && inRange(x.d) && (!area || x.area === area));
  const add = (list, k) => list.reduce((m, x) => m + x[k], 0) / 60;
  const unassigned = loose.filter((x) => x.kind === 'unassigned');
  const notTaking = loose.filter((x) => x.kind === 'not_taking');
  const avail = add(days, 'avail');
  const assigned = add(days, 'assigned');
  const unassignedH = add(unassigned, 'hours');
  const notTakingH = add(notTaking, 'hours');
  const travel = add(days, 'travel') + add(loose, 'travel');
  const frag = add(days, 'frag');
  const raw = avail - assigned - unassignedH - notTakingH;
  const adjusted = raw - travel - frag;
  return { closed: add(days, 'closed'), avail, assigned, unassigned: unassignedH, unassigned_visits: unassigned.length, not_taking: notTakingH, not_taking_visits: new Set(notTaking.map((x) => x.key)).size, travel, frag, raw, adjusted, raw_pct: ratio(raw, avail), adjusted_pct: ratio(adjusted, avail) };
}
const rounded = (s, cfg) => ({
  closed_h: r1(s.closed), available_h: r1(s.avail), assigned_h: r1(s.assigned), unassigned_h: r1(s.unassigned), unassigned_visits: s.unassigned_visits,
  not_taking_h: r1(s.not_taking), not_taking_visits: s.not_taking_visits, travel_h: r1(s.travel), fragments_h: r1(s.frag),
  raw_h: r1(s.raw), raw_pct: s.raw_pct, adjusted_h: r1(s.adjusted), adjusted_pct: s.adjusted_pct,
  raw_status: statusOf(s.raw_pct, cfg), status: statusOf(s.adjusted_pct, cfg),
});

/**
 * The whole report.
 * existing: what Scheduling insights shows today, for the reconciliation strip:
 *   { capacity4, booked4, unassigned_visits, tolerance } (planner overview, 4 weeks and all future;
 *   tolerance = the rounding the planner applies, 0.05 h per cleaner-week)
 * travelRef: { measured: { minutes, visits, share }, estimated: { minutes, legs } } (optional)
 */
export function headroomReport({ facts, weeks = 4, cfg = HEADROOM, cleaners, existing = null, travelRef = null, takenAt = null }) {
  const { today } = facts;
  const win = windowDates(today, weeks);
  const inWin = (d) => d >= win.from && d <= win.to;
  const total4 = sum(facts, inWin);

  // Ratio: unique cleaners taking bookings : unique customers with a visit in the window.
  const cust = facts.customers.filter((x) => !x.sunday && inWin(x.d));
  const custAll = new Set(cust.map((x) => x.customer));
  const custRec = new Set(cust.filter((x) => x.recurring).map((x) => x.customer));
  const nCleaners = facts.taking.length;

  // Areas.
  const names = [...new Set([...cfg.areas, ...facts.days.map((x) => x.area), ...facts.loose.filter((x) => x.brand).map((x) => x.area)])];
  const areas = names.map((area) => {
    const s = sum(facts, inWin, area);
    const ac = cust.filter((x) => x.area === area);
    const cl = facts.taking.filter((c) => (c.area || 'Unknown') === area).length;
    const nc = new Set(ac.map((x) => x.customer)).size;
    return { area, cleaners: cl, customers: nc, customers_recurring: new Set(ac.filter((x) => x.recurring).map((x) => x.customer)).size, customers_per_cleaner: cl ? r1(nc / cl) : null, ...rounded(s, cfg), _s: s };
  }).filter((a) => cfg.areas.includes(a.area) || a.cleaners || a.available_h || a.unassigned_h || a.assigned_h);

  // Cleaners: key-person risk = their assigned hours ÷ their area's adjusted headroom hours.
  const areaS = new Map(areas.map((a) => [a.area, a._s]));
  const byCleaner = facts.taking.map((c) => {
    const days = facts.days.filter((x) => x.cid === c.id && !x.sunday && inWin(x.d));
    const avail = days.reduce((m, x) => m + x.avail, 0) / 60;
    const assigned = days.reduce((m, x) => m + x.assigned, 0) / 60;
    const area = c.area || 'Unknown';
    const a = areaS.get(area);
    const leftAdj = a && assigned > 0 ? (a.adjusted > 0 ? assigned / a.adjusted : Infinity) : assigned > 0 ? Infinity : 0;
    const leftRaw = a && assigned > 0 ? (a.raw > 0 ? assigned / a.raw : Infinity) : assigned > 0 ? Infinity : 0;
    return {
      cleaner_id: c.id, name: c.name, area, status_label: c.status_label || null,
      available_h: r1(avail), assigned_h: r1(assigned), headroom_h: r1(avail - assigned), utilization: ratio(assigned, avail),
      // JSON has no Infinity: null + negative_area flag means their area is already at or below zero.
      if_left: Number.isFinite(leftAdj) ? leftAdj : null, if_left_raw: Number.isFinite(leftRaw) ? leftRaw : null,
      area_negative: !Number.isFinite(leftAdj),
      _sort: Number.isFinite(leftAdj) ? leftAdj : 1e9 + assigned,
    };
  }).sort((x, y) => y._sort - x._sort).map(({ _sort, ...rest }) => rest);

  // Trend: adjusted headroom % per area, each of the next N weeks (week 1 from today).
  const start = mondayOf(today);
  const trendWeeks = Array.from({ length: cfg.trendWeeks }, (_, i) => addDays(start, i * 7));
  const trend = trendWeeks.map((wk) => {
    const inWk = (d) => d >= wk && d <= addDays(wk, 6) && d >= today;
    const all = sum(facts, inWk);
    return { week: wk, total: all.adjusted_pct, raw_total: all.raw_pct, areas: Object.fromEntries(areas.map((a) => [a.area, sum(facts, inWk, a.area).adjusted_pct])) };
  });

  // Reconciliation with Scheduling insights' own figures.
  let reconcile = null;
  if (existing) {
    const four = windowDates(today, 4);
    const in4 = (d) => d >= four.from && d <= four.to;
    const d4 = facts.days.filter((x) => in4(x.d));
    const h = (list, k) => list.reduce((m, x) => m + x[k], 0) / 60;
    const sundays = d4.filter((x) => x.sunday);
    const weekdays = d4.filter((x) => !x.sunday);
    const capSteps = {
      existing: existing.capacity4,
      sundays: h(sundays, 'base'),
      closed: h(weekdays, 'closed'),
      other_brand: h(weekdays, 'other'),
      // Days where hours booked elsewhere leave less than nothing are floored at zero.
      floor: h(weekdays, 'base') - h(weekdays, 'closed') - h(weekdays, 'other') - h(weekdays, 'avail'),
      result: h(weekdays, 'avail'),
    };
    const bookSteps = {
      existing: existing.booked4,
      sundays: h(sundays, 'assigned') + h(sundays, 'otherBooked'),
      other_brand: h(weekdays, 'otherBooked'),
      result: h(weekdays, 'assigned'),
    };
    const un = facts.loose.filter((x) => x.kind === 'unassigned');
    const unSteps = {
      existing: existing.unassigned_visits,
      other_brand: un.filter((x) => !x.brand).length,
      sundays: un.filter((x) => x.brand && x.sunday).length,
      later: un.filter((x) => x.brand && !x.sunday && x.d > win.to).length,
      result: un.filter((x) => x.brand && !x.sunday && x.d <= win.to).length,
    };
    // Ties when existing − each step = result (within rounding: the planner rounds each week to 0.1 h).
    const tol = existing.tolerance ?? 0.5;
    const tie = (s, keys) => s.existing != null && Math.abs(keys.reduce((m, k) => m - s[k], s.existing) - s.result) <= tol;
    reconcile = {
      capacity: { ...mapR1(capSteps), tolerance: r1(tol), ties: tie(capSteps, ['sundays', 'closed', 'other_brand', 'floor']) },
      booked: { ...mapR1(bookSteps), ties: tie(bookSteps, ['sundays', 'other_brand']) },
      unassigned: { ...unSteps, ties: unSteps.existing - unSteps.other_brand - unSteps.sundays - unSteps.later === unSteps.result },
      window_weeks: weeks,
    };
  }

  return {
    taken_at: takenAt, today, weeks, from: win.from, to: win.to,
    config: { travel_model: 'route', travel_return_home: cfg.travelReturnHome, travel_fallback_min: cfg.travelFallbackMinutes, avg_leg_min: Math.round(facts.avg_leg_min), fragment_h: cfg.fragmentMinHours, red_at: cfg.redAt, amber_at: cfg.amberAt, operating_days: cfg.operatingDays, windows: cfg.windows },
    totals: rounded(total4, cfg),
    ratio: { cleaners: nCleaners, customers: custAll.size, customers_recurring: custRec.size, per_cleaner: nCleaners ? r1(custAll.size / nCleaners) : null, per_cleaner_recurring: nCleaners ? r1(custRec.size / nCleaners) : null },
    areas: areas.map(({ _s, ...a }) => a),
    cleaners: byCleaner,
    trend,
    reconcile,
    travel_reference: travelRef,
    cleaners_in_scope: cleaners?.length ?? null,
  };
}
function mapR1(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r1(v) : v]));
}

// What the existing "en route" taps and the planner's distance model say about travel.
// pastVisits: report snapshot visits (teams[].enroute / checkin ISO). Measured = tap → check-in.
export function travelReference({ pastVisits = [], from, to, facts = null, cleaners = [], visits = [] }) {
  const mins = [];
  let tracked = 0;
  for (const v of pastVisits) {
    if (v.date < from || v.date > to) continue;
    for (const t of v.teams || []) {
      if (!t.checkin) continue;
      tracked++;
      if (!t.enroute) continue;
      const m = (Date.parse(t.checkin) - Date.parse(t.enroute)) / 60_000;
      if (m > 0 && m <= 120) mins.push(m);
    }
  }
  mins.sort((a, b) => a - b);
  const med = mins.length ? mins[Math.floor(mins.length / 2)] : null;
  const avg = mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : null;
  // Planner estimate: between consecutive visits in the same cleaner's day (upcoming).
  const legs = [];
  if (facts) {
    const byId = new Map(cleaners.map((c) => [c.id, c]));
    const days = new Map();
    for (const v of visits) {
      if (v.date < facts.today || v.date > facts.end) continue;
      for (const id of v.team_ids) {
        const k = `${id}|${v.date}`;
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(v);
      }
    }
    for (const [k, list] of days) {
      const c = byId.get(Number(k.split('|')[0]));
      const s = [...list].sort((a, b) => a.start - b.start);
      for (let i = 1; i < s.length; i++) {
        const d = km(s[i - 1], s[i]);
        if (d != null) legs.push(travelMinutes(d, !!c?.rules?.transit));
      }
    }
  }
  return {
    measured: { median_min: med == null ? null : Math.round(med), average_min: avg == null ? null : Math.round(avg), visits: mins.length, share_tapped: tracked ? mins.length / tracked : null, from, to },
    estimated: { average_min: legs.length ? Math.round(legs.reduce((a, b) => a + b, 0) / legs.length) : null, legs: legs.length },
  };
}
