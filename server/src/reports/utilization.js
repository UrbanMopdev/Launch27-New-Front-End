// Utilization: of the hours cleaners have open, how much is already spoken for, and how much is
// left to book.
//
//   Available   = cleaners' open hours (taking bookings), Monday–Saturday
//   Spoken for  = assigned + unassigned (+ work on cleaners not taking bookings) + travel
//   Left        = available − spoken for
//   Utilization = spoken for ÷ available
//
// Pure calculation over the planner's saved copy of Launch27 (no fetching, no writes).
// Available hours = each cleaner's hours in Launch27 (weekly hours, or that date's own hours
// when set), minus days off set in Launch27 or marked unavailable in this app, minus company
// closed dates (unless the cleaner has their own hours set for that date).
import { addDays, areaOf, km, mondayOf, toMinutes, travelMinutes, weekday, workingWindow } from '../schedule/rules.js';
import { UTILIZATION } from './utilization-config.js';

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

/**
 * The per-day facts every figure is summed from.
 * input: { today, cleaners, visits, holidays, unavailable: Map(id -> Set(dates)), locations, cfg, until }
 *   cleaners: planner cleaners ({ id, name, area, assignable, location_ids, availability, lat, lng, rules })
 *   visits:   planner visits from today on ({ key, date, start, end, duration, team_ids, team_hours, location_id, customer_id, kind, lat, lng })
 *   holidays: company closed dates ({ date, start_time, end_time, location_id })
 */
export function utilizationFacts({ today, cleaners, visits, holidays = [], unavailable = new Map(), locations = null, cfg = UTILIZATION, until }) {
  const brandIds = Array.isArray(locations) && locations.length ? new Set(locations.map(Number)) : null;
  const inBrand = (v) => !brandIds || brandIds.has(Number(v.location_id));
  const cleanerInBrand = (c) => !brandIds || !c.location_ids?.length || c.location_ids.some((id) => brandIds.has(Number(id)));
  const operating = new Set(cfg.operatingDays);
  // One leg of travel, in minutes (the planner's model; fallback when a pin is missing).
  const leg = (a, b, transit) => {
    const d = km(a, b);
    return d == null ? cfg.travelFallbackMinutes : travelMinutes(d, transit);
  };
  const legs = [];
  // Through the weekly chart's last week, or the last visit in the copy if later (so every
  // unassigned visit the planner counts is accounted for in the reconciliation).
  const lastVisit = visits.reduce((m, v) => (v.date > m ? v.date : m), today);
  const trendEnd = addDays(mondayOf(today), cfg.trendWeeks * 7 - 1);
  const end = until || (lastVisit > trendEnd ? lastVisit : trendEnd);

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
      let at = home;
      for (const v of route) {
        const m = leg(at, v, transit);
        if (inBrand(v)) travel += m;
        legs.push(m);
        at = v;
      }
      const last = route[route.length - 1];
      if (last && cfg.travelReturnHome && inBrand(last)) travel += leg(last, home, transit);
      days.push({ d, sunday, cid: c.id, area: c.area || 'Unknown', base, closed: closedMin, other: otherMin, avail, assigned, otherBooked, travel, visits: mine.length });
    }
  }

  // Visits not on a taking cleaner: unassigned, or on a cleaner not taking bookings (on hold, etc.).
  const loose = [];
  const customers = [];
  for (const v of future) {
    const sunday = !operating.has(weekday(v.date));
    const brand = inBrand(v);
    const addrArea = areaOf({ lat: v.lat, lng: v.lng });
    if (brand && v.customer_id != null) customers.push({ d: v.date, sunday, customer: v.customer_id, recurring: v.kind !== 'one', area: addrArea });
    if (!v.team_ids.length) {
      loose.push({ kind: 'unassigned', d: v.date, sunday, brand, area: addrArea, hours: v.duration, travel: 0, key: v.key });
      continue;
    }
    if (!brand) continue;
    for (const id of v.team_ids) {
      if (takingIds.has(id)) continue;
      const c = byId.get(id);
      loose.push({ kind: 'not_taking', d: v.date, sunday, brand, area: c?.area || addrArea, hours: share(v, id), travel: 0, cid: id, key: v.key });
    }
  }
  // Visits not on a taking cleaner have no route of their own: one average leg each.
  const avgLeg = legs.length ? legs.reduce((a, b) => a + b, 0) / legs.length : cfg.travelFallbackMinutes;
  for (const x of loose) x.travel = avgLeg;
  return { days, loose, customers, taking, today, end, avg_leg_min: avgLeg };
}

// Sum the facts for a set of dates (and optionally one area).
function sum(facts, inRange, area = null, cfg = UTILIZATION) {
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
  const spoken = assigned + unassignedH + notTakingH + travel;
  const left = avail - spoken;
  // Room for more bookings: hours left ÷ (a typical booking + one average leg of travel).
  const visits = days.reduce((m, x) => m + x.visits, 0);
  const typical = visits ? assigned / visits : cfg.typicalBookingHours;
  const perBooking = typical + facts.avg_leg_min / 60;
  return {
    closed: add(days, 'closed'), avail, assigned, unassigned: unassignedH, unassigned_visits: unassigned.length,
    not_taking: notTakingH, not_taking_visits: new Set(notTaking.map((x) => x.key)).size, travel, spoken, left,
    utilization: ratio(spoken, avail), room: left > 0 && perBooking > 0 ? Math.floor(left / perBooking) : 0, typical,
  };
}
const rounded = (s) => ({
  closed_h: r1(s.closed), available_h: r1(s.avail), assigned_h: r1(s.assigned), unassigned_h: r1(s.unassigned), unassigned_visits: s.unassigned_visits,
  not_taking_h: r1(s.not_taking), not_taking_visits: s.not_taking_visits, travel_h: r1(s.travel),
  spoken_h: r1(s.spoken), left_h: r1(s.left), utilization: s.utilization, room_bookings: s.room, typical_booking_h: r1(s.typical),
});

// The dates that can be shown: from today until the end of the planner's copy.
export function clampRange(today, from, to, maxTo) {
  const ok = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  let f = ok(from) ? from : today;
  let t = ok(to) ? to : addDays(today, 6);
  if (f < today) f = today;
  if (t > maxTo) t = maxTo;
  if (f > maxTo) f = maxTo;
  if (t < f) t = f;
  return { from: f, to: t };
}

/**
 * The whole report for the dates from..to (inclusive).
 * existing: Scheduling insights' own figures, for "Check the numbers":
 *   { capacity4, booked4, unassigned_visits, tolerance } (planner overview: its 4 weeks, and all future;
 *   tolerance = the rounding the planner applies, 0.05 h per cleaner-week)
 */
export function utilizationReport({ facts, from, to, maxTo, cfg = UTILIZATION, existing = null, takenAt = null, cleaners: allCleaners = [], source = {} }) {
  const { today } = facts;
  const inWin = (d) => d >= from && d <= to;
  const all = sum(facts, inWin, null, cfg);
  const cust = facts.customers.filter((x) => !x.sunday && inWin(x.d));

  // Areas.
  const names = [...new Set([...cfg.areas, ...facts.days.map((x) => x.area), ...facts.loose.filter((x) => x.brand).map((x) => x.area)])];
  const areaSums = new Map();
  const areas = names.map((area) => {
    const s = sum(facts, inWin, area, cfg);
    areaSums.set(area, s);
    const ac = cust.filter((x) => x.area === area);
    return { area, cleaners: facts.taking.filter((c) => (c.area || 'Unknown') === area).length, customers: new Set(ac.map((x) => x.customer)).size, customers_recurring: new Set(ac.filter((x) => x.recurring).map((x) => x.customer)).size, ...rounded(s) };
  }).filter((a) => cfg.areas.includes(a.area) || a.cleaners || a.available_h || a.unassigned_h || a.assigned_h);

  // Cleaners, with their own travel; "if they left" = their booked + travel hours ÷ their area's hours left.
  const cleaners = facts.taking.map((c) => {
    const days = facts.days.filter((x) => x.cid === c.id && !x.sunday && inWin(x.d));
    const h = (k) => days.reduce((m, x) => m + x[k], 0) / 60;
    const avail = h('avail'), assigned = h('assigned'), travel = h('travel');
    const visits = days.reduce((m, x) => m + x.visits, 0);
    const area = c.area || 'Unknown';
    const left = areaSums.get(area)?.left ?? 0;
    const load = assigned + travel;
    return {
      cleaner_id: c.id, name: c.name, area, status_label: c.status_label || null, visits,
      available_h: r1(avail), assigned_h: r1(assigned), travel_h: r1(travel), travel_per_visit_min: visits ? Math.round((travel * 60) / visits) : null,
      left_h: r1(avail - assigned - travel), utilization: ratio(assigned + travel, avail),
      // null + area_short: their area already has no hours left.
      if_left: load > 0 && left > 0 ? load / left : load > 0 ? null : 0, area_short: load > 0 && left <= 0,
    };
  }).sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));

  // By day (Monday–Saturday) in the chosen dates.
  const byDay = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!cfg.operatingDays.includes(weekday(d))) continue;
    const one = (x) => x === d;
    byDay.push({ date: d, ...rounded(sum(facts, one, null, cfg)), areas: Object.fromEntries(areas.map((a) => [a.area, rounded(sum(facts, one, a.area, cfg))])) });
  }

  // Weekly chart: utilization per area, each of the next N weeks (week 1 from today).
  const start = mondayOf(today);
  const trend = Array.from({ length: cfg.trendWeeks }, (_, i) => addDays(start, i * 7)).map((wk) => {
    const inWk = (d) => d >= wk && d <= addDays(wk, 6) && d >= today;
    return { week: wk, total: sum(facts, inWk, null, cfg).utilization, areas: Object.fromEntries(areas.map((a) => [a.area, sum(facts, inWk, a.area, cfg).utilization])) };
  });

  // Check the numbers: Scheduling insights' figures, step by step to this page's.
  let reconcile = null;
  if (existing) {
    const four = addDays(mondayOf(today), 27);
    const d4 = facts.days.filter((x) => x.d >= today && x.d <= four);
    const h = (list, k) => list.reduce((m, x) => m + x[k], 0) / 60;
    const sundays = d4.filter((x) => x.sunday);
    const weekdays = d4.filter((x) => !x.sunday);
    const capSteps = { existing: existing.capacity4, sundays: h(sundays, 'base'), closed: h(weekdays, 'closed'), other_brand: h(weekdays, 'other'), floor: h(weekdays, 'base') - h(weekdays, 'closed') - h(weekdays, 'other') - h(weekdays, 'avail'), result: h(weekdays, 'avail') };
    const bookSteps = { existing: existing.booked4, sundays: h(sundays, 'assigned') + h(sundays, 'otherBooked'), other_brand: h(weekdays, 'otherBooked'), result: h(weekdays, 'assigned') };
    const un = facts.loose.filter((x) => x.kind === 'unassigned');
    const unSteps = { existing: existing.unassigned_visits, other_brand: un.filter((x) => !x.brand).length, sundays: un.filter((x) => x.brand && x.sunday).length, outside: un.filter((x) => x.brand && !x.sunday && !inWin(x.d)).length, result: un.filter((x) => x.brand && !x.sunday && inWin(x.d)).length };
    const tol = existing.tolerance ?? 0.5;
    const tie = (s, keys) => s.existing != null && Math.abs(keys.reduce((m, k) => m - s[k], s.existing) - s.result) <= tol;
    const r1all = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r1(v) : v]));
    reconcile = {
      capacity: { ...r1all(capSteps), ties: tie(capSteps, ['sundays', 'closed', 'other_brand', 'floor']) },
      booked: { ...r1all(bookSteps), ties: tie(bookSteps, ['sundays', 'other_brand']) },
      unassigned: { ...unSteps, ties: unSteps.existing - unSteps.other_brand - unSteps.sundays - unSteps.outside === unSteps.result },
      hours_from: today, hours_to: four,
    };
  }

  return {
    taken_at: takenAt, today, from, to, max_to: maxTo, avg_leg_min: Math.round(facts.avg_leg_min),
    data_check: dataCheck({ facts, inWin, cleaners: allCleaners, source }),
    totals: { ...rounded(all), cleaners: facts.taking.length, customers: new Set(cust.map((x) => x.customer)).size, customers_recurring: new Set(cust.filter((x) => x.recurring).map((x) => x.customer)).size },
    areas, cleaners, by_day: byDay, trend, reconcile,
  };
}

// Data check: per cleaner, what the report knows from Launch27 and what looks wrong, for the dates
// shown. Cleaners taking bookings, plus anyone else with bookings in these dates.
const FLAG = {
  refused: 'Launch27 refused their hours',
  booked_no_hours: 'Booked, but 0 available hours',
  booked_not_taking: 'Booked, but not taking bookings',
  no_hours: 'No hours set in Launch27',
  no_home: 'No home location (area Unknown)',
};
const FLAG_ORDER = Object.keys(FLAG);
export function dataCheck({ facts, inWin, cleaners = [], source = {} }) {
  const takingIds = new Set(facts.taking.map((c) => c.id));
  const per = new Map();
  for (const x of facts.days) {
    if (x.sunday || !inWin(x.d)) continue;
    const p = per.get(x.cid) || { avail: 0, booked: 0, visits: 0 };
    p.avail += x.avail;
    p.booked += x.assigned;
    p.visits += x.visits;
    per.set(x.cid, p);
  }
  for (const x of facts.loose) {
    if (x.kind !== 'not_taking' || x.sunday || !x.brand || !inWin(x.d)) continue;
    const p = per.get(x.cid) || { avail: 0, booked: 0, visits: 0 };
    p.booked += x.hours;
    p.visits += 1;
    per.set(x.cid, p);
  }
  const rows = [];
  for (const c of cleaners) {
    const taking = takingIds.has(c.id);
    const p = per.get(c.id) || { avail: 0, booked: 0, visits: 0 };
    if (!taking && !p.visits) continue;
    const weekly = (c.availability || []).filter((r) => !r.date);
    const weeklyH = c.weekly_hours ?? null;
    const flags = [];
    if (c.availability_error) flags.push('refused');
    if (taking && p.visits && p.avail <= 0) flags.push('booked_no_hours');
    if (!taking && p.visits) flags.push('booked_not_taking');
    if (!c.availability_error && taking && !(weeklyH > 0)) flags.push('no_hours');
    if (c.lat == null || c.lng == null) flags.push('no_home');
    rows.push({
      cleaner_id: c.id, name: c.name, status_label: c.status_label || null, taking, area: c.area || 'Unknown',
      home_location: c.lat != null && c.lng != null, weekly_hours: weeklyH, weekly_rows: weekly.length, dated_rows: (c.availability || []).length - weekly.length,
      availability_error: c.availability_error || null,
      available_h: r1(p.avail / 60), booked_h: r1(p.booked / 60), visits: p.visits,
      flags: flags.map((k) => ({ kind: k, label: FLAG[k] })),
    });
  }
  const rank = (r) => (r.flags.length ? Math.min(...r.flags.map((f) => FLAG_ORDER.indexOf(f.kind))) : 99);
  rows.sort((a, b) => rank(a) - rank(b) || b.booked_h - a.booked_h || a.name.localeCompare(b.name));
  const counts = Object.fromEntries(FLAG_ORDER.map((k) => [k, rows.filter((r) => r.flags.some((f) => f.kind === k)).length]));
  return { refreshed_at: source.full_at || null, read_by: source.cleaners_by || null, counts, labels: FLAG, cleaners: rows };
}
