// Pure calculations over the 12-month Launch27 visit snapshot (reports/service.js):
//   journeyAt   – the client as of the complaint (tenure, frequency, spend, cleaner changes…)
//   outcomeAt   – SAVED / PARTIAL SAVE / LOST / pending at day 30, 60, 90
//   recleanCost – what a reclean really costs (labour + travel + the lost slot's margin)
// Visits: { id, date 'YYYY-MM-DD', at ms, revenue, freq, customer_id, teams:[{id,name,hours,earned}], rating:{r,comment} }

const DAY = 86_400_000;
const days = (a, b) => Math.round((b - a) / DAY);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** visitsByCustomer: Map(customer_id -> visits sorted by time). at: complaint time (ms). */
export function journeyAt(list, at, { priorCases = [], cleanerStatsAt = null, dataFrom = null, complainedVisitId = null, cleanerLastWorked = null, dataTo = null } = {}) {
  const before = (list || []).filter((v) => v.at < at);
  const last = before[before.length - 1] || null;
  const first = before[0] || null;
  const last90 = before.filter((v) => v.at >= at - 90 * DAY);
  const cleaners90 = new Set(last90.flatMap((v) => v.teams.map((t) => t.id)));
  const prevTeam = before.length >= 2 ? before[before.length - 2].teams.map((t) => t.id).sort().join(',') : null;
  const lastTeam = last ? last.teams.map((t) => t.id).sort().join(',') : null;
  const prices = before.slice(-4).map((v) => v.revenue).filter((x) => x > 0);
  const priceChange = prices.length >= 2 ? (prices[prices.length - 1] - mean(prices.slice(0, -1))) / mean(prices.slice(0, -1)) : null;
  const cleaner = last?.teams?.[0] || null;
  const cs = cleaner && cleanerStatsAt ? cleanerStatsAt(cleaner.id, at) : null;
  const regular = regularCleaner(last90);
  const regularLast = regular && cleanerLastWorked ? cleanerLastWorked(regular.id) : null;
  return {
    tenure_days: first ? days(first.at, at) : null,
    frequency: last?.freq || null,
    cleans_total: before.length,
    spend_12m: Math.round(before.filter((v) => v.at >= at - 365 * DAY).reduce((s, v) => s + (v.revenue || 0), 0) * 100) / 100,
    price_change_pct: priceChange == null ? null : Math.round(priceChange * 1000) / 1000,
    distinct_cleaners_90d: cleaners90.size,
    cleaner_changed_last_visit: prevTeam != null && lastTeam != null ? prevTeam !== lastTeam : null,
    prior_complaints: priorCases.filter((c) => c.opened_at < at && c.opened_at >= at - 365 * DAY).length,
    prior_unhappy_ratings: before.filter((v) => v.id !== complainedVisitId && v.rating && v.rating.r === 0).length,
    days_since_last_clean: last ? days(last.at, at) : null,
    cleaner_id: cleaner?.id ?? null,
    cleaner_name: cleaner?.name ?? null,
    cleaner_visits_before: cs?.visits ?? null,
    cleaner_unhappy_rate_90d: cs?.unhappyRate ?? null,
    data_from: dataFrom,
    ...planValue(before),
    regular_cleaner_name: regular?.name ?? null,
    regular_cleaner_last_worked: regularLast ? new Date(regularLast).toISOString().slice(0, 10) : null,
    // Stopped working with us: their last visit with any client was before the complaint and
    // at least LEFT_AFTER_DAYS before the end of the data (so a week off doesn't count).
    regular_cleaner_left: regular && regularLast && dataTo ? regularLast < at && dataTo - regularLast >= LEFT_AFTER_DAYS * DAY : null,
  };
}

// Visits a year by frequency. One-time clients have no plan: what is at stake is one more booking.
export const VISITS_A_YEAR = { weekly: 52, bi: 26, tri: 17, monthly: 13, one: 1 };
const freqKind = (name) => {
  const n = String(name || '').toLowerCase();
  if (/one\s*-?\s*time/.test(n)) return 'one';
  if (/tri\s*-?\s*weekly/.test(n)) return 'tri';
  if (/bi\s*-?\s*weekly/.test(n)) return 'bi';
  if (/weekly/.test(n)) return 'weekly';
  if (/month/.test(n)) return 'monthly';
  return 'one';
};
/**
 * The client's plan as of the complaint: their usual visit price (the median of their last
 * three paid visits, so a pricier first deep clean doesn't set it once regular visits exist)
 * times the visits a year their frequency means. Null when they have no paid visit yet.
 */
export function planValue(before) {
  const paid = (before || []).filter((v) => (v.revenue || 0) > 0);
  if (!paid.length) return { visit_price: null, plan_value: null };
  const last3 = paid.slice(-3).map((v) => v.revenue).sort((a, b) => a - b);
  const price = last3[Math.floor((last3.length - 1) / 2)];
  const kind = freqKind(paid[paid.length - 1].freq);
  return { visit_price: Math.round(price * 100) / 100, plan_value: Math.round(price * VISITS_A_YEAR[kind] * 100) / 100 };
}

export const LEFT_AFTER_DAYS = 21;
// The client's regular cleaner: the one on most of their visits (at least two) in the window.
export function regularCleaner(visits) {
  const n = new Map();
  for (const v of visits) for (const t of v.teams || []) n.set(t.id, { id: t.id, name: t.name, n: (n.get(t.id)?.n || 0) + 1 });
  const top = [...n.values()].sort((a, b) => b.n - a.n)[0];
  return top && top.n >= 2 ? { id: top.id, name: top.name || null } : null;
}

/** When each cleaner last worked a visit (any client), from all visits up to `untilMs`. */
export function cleanerLastWorkedIndex(visits, untilMs = Infinity) {
  const last = new Map();
  for (const v of visits) if (v.at <= untilMs) for (const t of v.teams || []) if (!(last.get(t.id) >= v.at)) last.set(t.id, v.at);
  return (id) => last.get(id) ?? null;
}

/** Per-cleaner experience and unhappy-rating rate before a moment, from all visits. */
export function cleanerStatsIndex(visits) {
  const byCleaner = new Map();
  for (const v of visits) for (const t of v.teams) {
    if (!byCleaner.has(t.id)) byCleaner.set(t.id, []);
    byCleaner.get(t.id).push(v);
  }
  for (const l of byCleaner.values()) l.sort((a, b) => a.at - b.at);
  return (id, at) => {
    const l = (byCleaner.get(id) || []).filter((v) => v.at < at);
    const recent = l.filter((v) => v.at >= at - 90 * DAY && v.rating);
    return { visits: l.length, unhappyRate: recent.length >= 5 ? Math.round((recent.filter((v) => v.rating.r === 0).length / recent.length) * 1000) / 1000 : null };
  };
}

/**
 * Outcome checked `day` days after the complaint (briefed definitions):
 *   saved        – still booking 60+ days after, and no 1–2★ public review
 *   lost         – stopped booking within 60 days, and/or a 1–2★ public review
 *   pending      – too early to tell (the 30-day check is never final)
 * "Still booking at the mark" = a visit or an upcoming booking on/after the mark, or a last
 * visit within the client's normal gap before it (21 days; 35 for monthly clients), once
 * that gap has fully passed.
 */
export const LEFT_WITHIN_DAYS = 90;
export function outcomeAt(list, at, day, { today, upcoming = [], negativeReview = null, repeatCaseId = null }) {
  // Derek's rules (Nov 28 2026):
  //   LOST   the client left within LEFT_WITHIN_DAYS of the complaint, review or no review, or
  //          posted a 1-2 star review. "Left" = no visit, done or booked, for a full normal gap
  //          after their last one (21 days; 35 for monthly clients).
  //   SAVED  still booking 60+ days after the complaint, no 1-2 star review, and not gone
  //          within LEFT_WITHIN_DAYS. A client saved at day 60 who then stops before day 90
  //          becomes LOST.
  // There is no "partial save". Whether a lost client left a bad review is kept beside the
  // outcome (public_review_stars), so responses that prevented reviews can still be seen.
  const mark = at + 60 * DAY;
  const all = [...(list || []), ...upcoming].sort((a, b) => a.at - b.at);
  const after = all.filter((v) => v.at > at);
  const last = all[all.length - 1] || null;
  const grace = /month|4 ?week/i.test(String(last?.freq || '')) ? 35 : 21;
  const negative = negativeReview?.stars != null && negativeReview.stars <= 2;
  const base = {
    day,
    next_booking_on: after[0]?.date || null,
    last_booking_on: (list || []).filter((v) => v.at <= today).slice(-1)[0]?.date || null,
    public_review_stars: negativeReview?.stars ?? null,
    public_review_platform: negativeReview?.platform ?? null,
    repeat_case_id: repeatCaseId,
  };
  const bookedPast = (m) => after.some((v) => v.at >= m);
  if (negative) return { ...base, still_booking: bookedPast(mark), outcome: 'lost' };
  // Their last visit of all, done or booked. They have left once a full gap has passed since it.
  const lastAt = last && last.at > at ? last.at : at;
  const left = today >= lastAt + grace * DAY;
  if (left && lastAt < at + LEFT_WITHIN_DAYS * DAY) return { ...base, still_booking: false, outcome: 'lost' };
  if (day < 60) return { ...base, still_booking: left ? false : null, outcome: 'pending' };
  if (bookedPast(mark)) return { ...base, still_booking: true, outcome: 'saved' };
  return { ...base, still_booking: null, outcome: 'pending' };
}
export function oneTimeOutcomeAt(list, at, day, { today, upcoming = [], repeatCaseId = null }) {
  const end = at + day * DAY;
  const after = [...(list || []), ...upcoming].filter((v) => v.at > at + DAY).sort((a, b) => a.at - b.at);
  const back = after.find((v) => v.at <= end);
  return {
    day,
    still_booking: back ? true : today >= end ? false : null,
    next_booking_on: after[0]?.date || null,
    last_booking_on: (list || []).filter((v) => v.at <= today).slice(-1)[0]?.date || null,
    public_review_stars: null,
    public_review_platform: null,
    repeat_case_id: repeatCaseId,
    outcome: back ? 'rebooked' : today >= end ? 'not_rebooked' : 'pending',
  };
}

/**
 * Real cost of a reclean. Labour = what the cleaner earns for it (hours × their effective
 * hourly pay on recent visits, or the setting's default). Travel = the setting's flat
 * per-visit travel cost. Lost slot = the average gross margin of a residential visit of that
 * length that week (revenue − cleaner pay), because the reclean occupies a bookable slot.
 */
/**
 * What a reclean costs (Derek's rule, Nov 28 2026): the reclean's hours times the hourly wage
 * of the cleaner who did it. Hours: those booked on the reclean visit, else the default (2).
 * Wage: that cleaner's real rate from Launch27 pay, else the default ($22). No travel and no
 * lost-slot margin unless switched back on in settings (include_travel, include_lost_slot).
 */
export function recleanCost({ hours, cleanerHourly, marginPerHour, travel, spot = false }, settings) {
  const h = (hours || settings.reclean_default_hours) * (spot ? settings.reclean_spot_share : 1);
  const labour = h * (cleanerHourly || settings.cleaner_hourly_default);
  const tr = settings.include_travel ? travel ?? settings.travel_per_visit : 0;
  const slot = settings.include_lost_slot ? h * (marginPerHour ?? settings.margin_per_hour_default) : 0;
  return { hours: Math.round(h * 10) / 10, labour: Math.round(labour * 100) / 100, travel: tr, lost_slot: Math.round(slot * 100) / 100, total: Math.round((labour + tr + slot) * 100) / 100 };
}

/** Each cleaner's real hourly rate: the median of pay / hours over their paid visits. */
export function cleanerRateIndex(visits) {
  const by = new Map();
  for (const v of visits) for (const t of v.teams || []) if (t.earned > 0 && t.hours > 0) by.set(t.id, [...(by.get(t.id) || []), t.earned / t.hours]);
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
  const rates = new Map([...by].map(([id, xs]) => [id, Math.round(med(xs) * 100) / 100]));
  return (id) => rates.get(id) ?? null;
}

/**
 * The cost of one reclean visit: for each cleaner on it, their hours (2 if none booked) times
 * their wage. Recleans are always paid: a $0 or missing "earned" on the visit means the pay
 * was recorded somewhere else, so the cleaner's own rate is used (then the default), and the
 * line is marked estimated. Actual only when every cleaner's pay is on the visit.
 */
export function recleanVisitCost(visit, rateOf, settings) {
  const teams = visit?.teams?.length ? visit.teams : [{ id: null, hours: null, earned: null }];
  let total = 0;
  let hours = 0;
  let actual = true;
  for (const t of teams) {
    const h = t.hours > 0 ? t.hours : settings.reclean_default_hours;
    hours += h;
    if (t.earned > 0) total += t.earned;
    else {
      actual = false;
      total += h * ((t.id != null && rateOf ? rateOf(t.id) : null) || settings.cleaner_hourly_default);
    }
  }
  return { labour: Math.round(total * 100) / 100, hours: Math.round(hours * 10) / 10, estimated: !actual };
}

export function unitEconomics(visits, sinceMs) {
  let pay = 0;
  let hours = 0;
  let revenue = 0;
  for (const v of visits) {
    if (v.at < sinceMs) continue;
    for (const t of v.teams) {
      if (t.earned == null || !t.hours) continue;
      pay += t.earned;
      hours += t.hours;
    }
    if (v.teams.every((t) => t.earned != null && t.hours)) revenue += v.revenue || 0;
  }
  if (!hours) return { cleanerHourly: null, marginPerHour: null };
  return { cleanerHourly: Math.round((pay / hours) * 100) / 100, marginPerHour: Math.round(((revenue - pay) / hours) * 100) / 100 };
}
