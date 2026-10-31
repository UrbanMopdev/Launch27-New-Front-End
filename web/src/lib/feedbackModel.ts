// Feedback analytics: turns rated bookings into features and computes drivers, cleaner
// rankings, comment themes, a weekly control chart and the customers to follow up.
//
// Outcome: a rating is "dissatisfied" when it's Okay or Unhappy (rating < 2). Launch27
// maps ratings to stars as 5 / 2.5 / 1, so stars add nothing beyond the rating.

import type { Booking } from '../types';
import { benjaminiHochberg, betaPosterior, betaPrior, logisticRegression, logOddsZ, quantile, twoProportion, wilson } from './stats';
import { TIMEZONE } from '../format';

export interface FeedbackInfo {
  stars: number;
  rating: 0 | 1 | 2;
  comment?: string | null;
  rated_at?: string;
}
export type RatedBooking = Booking & { feedback: FeedbackInfo; created_at?: string; duration?: number };

export const isDissatisfied = (r: RatedBooking) => r.feedback.rating < 2;
export const isUnhappy = (r: RatedBooking) => r.feedback.rating === 0;

// ---------- Features ----------

export type FeatureGroup = 'Extras' | 'Service' | 'Home' | 'Frequency' | 'Scheduling' | 'Execution' | 'Price' | 'Location';

export interface FeatureDef {
  key: string;
  label: string;
  group: FeatureGroup;
}

const localParts = (iso: string) => {
  const d = new Date(iso);
  const hour = Number(d.toLocaleString('en-US', { timeZone: TIMEZONE, hour: 'numeric', hour12: false })) % 24;
  const weekday = d.toLocaleString('en-US', { timeZone: TIMEZONE, weekday: 'short' });
  return { hour, weekday };
};

const freqGroup = (name = '') => {
  const n = name.toLowerCase();
  if (n.includes('one time')) return 'One-time';
  if (n.includes('tri')) return 'Tri-weekly';
  if (n.includes('biweekly')) return 'Biweekly';
  if (n.includes('weekly')) return 'Weekly';
  if (n.includes('monthly')) return 'Monthly';
  return name || 'Unknown';
};
const ANNUAL_VISITS: Record<string, number> = { Weekly: 52, Biweekly: 26, 'Tri-weekly': 17, Monthly: 12, 'One-time': 0 };

const customValue = (r: RatedBooking, titleWord: string) => {
  const f = (r.custom_fields || []).find((c) => (c.title || '').toLowerCase().includes(titleWord));
  const v = f?.values?.[0];
  return (v?.label || v?.name || v?.value || '').toString();
};

/** Actual vs booked labour and lateness from the booking's time-tracking records. */
export function execution(r: RatedBooking) {
  const tts = (r.time_tracking || []).filter((t) => t.checkin_at);
  const firstCheckin = tts.map((t) => new Date(t.checkin_at!).getTime()).sort((a, b) => a - b)[0];
  const windowEnd = new Date(r.service_date || '').getTime() + (Number(r.arrival_window) || 0) * 60_000;
  const lateMin = firstCheckin ? (firstCheckin - windowEnd) / 60_000 : null;
  const allOut = tts.length > 0 && tts.every((t) => t.checkout_at);
  const worked = allOut ? tts.reduce((s, t) => s + (new Date(t.checkout_at!).getTime() - new Date(t.checkin_at!).getTime()) / 3_600_000, 0) : null;
  const booked = r.duration ? r.duration / 60 : null;
  return { lateMin, worked, booked, ratio: worked !== null && booked ? worked / booked : null };
}

export function annualValue(r: RatedBooking) {
  const visits = ANNUAL_VISITS[freqGroup(r.frequency?.name)] ?? 0;
  return (r.summary?.total || 0) * (visits || 1);
}

/** Feature dictionary for one booking. `ctx` carries dataset-level thresholds. */
export function featuresOf(r: RatedBooking, ctx: { priceP75: number }): Record<string, FeatureDef> {
  const out: Record<string, FeatureDef> = {};
  const add = (key: string, label: string, group: FeatureGroup) => (out[key] = { key, label, group });

  for (const s of r.services || []) {
    add(`service:${s.name}`, s.name, 'Service');
    for (const x of s.extras || []) if (x.quantity > 0) add(`extra:${x.name}`, x.name, 'Extras');
    const baths = (s.pricing_parameters || []).find((p) => /full bath/i.test(p.name));
    if (baths && baths.quantity >= 3) add('home:baths3', '3+ full bathrooms', 'Home');
  }
  if (!(r.services || []).some((s) => (s.extras || []).some((x) => x.quantity > 0))) add('extra:none', 'No extras', 'Extras');

  const pets = customValue(r, 'pets');
  if (pets && !/^no/i.test(pets)) add('home:pets', `Has pets`, 'Home');
  const parking = customValue(r, 'parking');
  if (parking && /^no/i.test(parking)) add('home:noparking', 'No parking on premises', 'Home');

  const fg = freqGroup(r.frequency?.name);
  add(`freq:${fg}`, fg, 'Frequency');
  if (/prepaid/i.test(r.frequency?.name || '')) add('freq:prepaid', 'Prepaid plan', 'Frequency');

  if (r.service_date) {
    const { hour, weekday } = localParts(r.service_date);
    if (hour >= 12) add('sched:afternoon', 'Afternoon start (12pm+)', 'Scheduling');
    if (weekday === 'Sat' || weekday === 'Sun') add('sched:weekend', 'Weekend visit', 'Scheduling');
    if (r.created_at && new Date(r.service_date).getTime() - new Date(r.created_at).getTime() < 48 * 3_600_000) add('sched:lastminute', 'Booked < 48h ahead', 'Scheduling');
  }
  if ((r.teams || []).length > 1) add('exec:multi', 'Two or more cleaners', 'Execution');
  if (!(r.teams || []).length) add('exec:unassigned', 'No cleaner assigned', 'Execution');

  const ex = execution(r);
  if (ex.lateMin !== null && ex.lateMin > 10) add('exec:late', 'Arrived > 10 min after window', 'Execution');
  if (ex.ratio !== null && ex.ratio < 0.85) add('exec:short', 'Worked < 85% of booked time', 'Execution');
  if (ex.ratio !== null && ex.ratio > 1.15) add('exec:long', 'Worked > 115% of booked time', 'Execution');
  if (!(r.time_tracking || []).some((t) => t.checkin_at)) add('exec:notracking', 'No check-in recorded', 'Execution');

  if ((r.summary?.total || 0) >= ctx.priceP75 && ctx.priceP75 > 0) add('price:top25', 'Top 25% price', 'Price');
  if ((r.summary?.discount || 0) > 0) add('price:discount', 'Discount applied', 'Price');
  if ((r.summary?.adjustment || 0) < 0) add('price:reduced', 'Price adjusted down', 'Price');
  if ((r.summary?.adjustment || 0) > 0) add('price:raised', 'Price adjusted up', 'Price');

  if (r.location?.name) add(`loc:${r.location.name}`, r.location.name, 'Location');
  return out;
}

// ---------- Drivers ----------

export interface Driver extends FeatureDef {
  n: number; // rated bookings with the feature
  k: number; // of which dissatisfied
  rate: number;
  ci: [number, number];
  rateWithout: number;
  ratio: number;
  pValue: number;
  qValue: number;
  adjOdds?: number;
  adjOddsCi?: [number, number];
  /** confirmed: significant raw (FDR q<0.1) and in the multivariate model; raw: raw only
   *  (likely explained by other factors); reference: baseline category in the model; ns: not significant */
  verdict: 'confirmed' | 'raw' | 'reference' | 'ns';
  significant: boolean;
}

export function analyseDrivers(rows: RatedBooking[], minN = 12): { drivers: Driver[]; baseRate: number; modelN: number } {
  const ctx = { priceP75: quantile(rows.map((r) => r.summary?.total || 0), 0.75) };
  const feats = rows.map((r) => featuresOf(r, ctx));
  const y: number[] = rows.map((r) => (isDissatisfied(r) ? 1 : 0));
  const totalK = y.reduce((a, b) => a + b, 0);
  const defs = new Map<string, FeatureDef>();
  const counts = new Map<string, { n: number; k: number }>();
  feats.forEach((f, i) => {
    for (const d of Object.values(f)) {
      defs.set(d.key, d);
      const c = counts.get(d.key) || { n: 0, k: 0 };
      c.n += 1;
      c.k += y[i];
      counts.set(d.key, c);
    }
  });

  // Keep features with enough support on both sides.
  const keys = [...counts.entries()].filter(([, c]) => c.n >= minN && rows.length - c.n >= minN).map(([k]) => k);
  const base: Omit<Driver, 'qValue' | 'significant' | 'verdict'>[] = keys.map((key) => {
    const { n, k } = counts.get(key)!;
    const t = twoProportion(k, n, totalK - k, rows.length - n);
    return { ...defs.get(key)!, n, k, rate: t.p1, ci: wilson(k, n), rateWithout: t.p2, ratio: t.ratio, pValue: t.pValue };
  });
  const q = benjaminiHochberg(base.map((d) => d.pValue));

  // Multivariate: adjusted odds ratios controlling for every other feature at once. Drop one
  // category per mutually exclusive group (frequency, location) to avoid perfect collinearity.
  // Baselines: a typical recurring plan for frequency, the largest location.
  const ref = new Set<string>();
  const freqKeys = keys.filter((k) => k.startsWith('freq:') && k !== 'freq:prepaid');
  const freqRef = ['freq:Biweekly', 'freq:Monthly', 'freq:Weekly'].find((k) => freqKeys.includes(k)) || freqKeys.sort((a, b) => counts.get(b)!.n - counts.get(a)!.n)[0];
  if (freqRef) ref.add(freqRef);
  const locKeys = keys.filter((k) => k.startsWith('loc:')).sort((a, b) => counts.get(b)!.n - counts.get(a)!.n);
  if (locKeys.length) ref.add(locKeys[0]);
  ref.add('extra:none');
  const modelKeys = keys.filter((k) => !ref.has(k));
  let adj = new Map<string, { or: number; ci: [number, number] }>();
  if (rows.length >= 60 && modelKeys.length) {
    const X = feats.map((f) => modelKeys.map((k) => (f[k] ? 1 : 0)));
    const fit = logisticRegression(X, y, 1);
    adj = new Map(modelKeys.map((k, j) => [k, { or: Math.exp(fit.coef[j]), ci: [Math.exp(fit.coef[j] - 1.96 * fit.se[j]), Math.exp(fit.coef[j] + 1.96 * fit.se[j])] as [number, number] }]));
  }

  const drivers: Driver[] = base.map((d, i) => {
    const a = adj.get(d.key);
    const rawSig = q[i] < 0.1;
    let verdict: Driver['verdict'] = 'ns';
    if (ref.has(d.key) || !a) verdict = 'reference';
    else if (rawSig && (a.ci[0] > 1 || a.ci[1] < 1)) verdict = 'confirmed';
    else if (rawSig) verdict = 'raw';
    return { ...d, qValue: q[i], adjOdds: a?.or, adjOddsCi: a?.ci, verdict, significant: verdict === 'confirmed' };
  });
  return { drivers, baseRate: rows.length ? totalK / rows.length : 0, modelN: rows.length };
}

// ---------- Cleaners ----------

export interface CleanerScore {
  id: number;
  name: string;
  n: number;
  k: number;
  unhappy: number;
  rawRate: number;
  adjRate: number;
  lo: number;
  hi: number;
  probWorse: number;
  flag: 'worse' | 'better' | null;
  lastComment?: string;
}

export function scoreCleaners(rows: RatedBooking[], baseRate: number): CleanerScore[] {
  const map = new Map<number, { name: string; list: RatedBooking[] }>();
  for (const r of rows) for (const t of r.teams || []) {
    if (!t.id) continue;
    const g = map.get(t.id) || { name: t.title || `Team ${t.id}`, list: [] };
    g.list.push(r);
    map.set(t.id, g);
  }
  const groups = [...map.entries()].map(([id, g]) => ({ id, name: g.name, list: g.list, n: g.list.length, k: g.list.filter(isDissatisfied).length }));
  const prior = betaPrior(groups);
  return groups
    .map((g) => {
      const post = betaPosterior(g.k, g.n, prior, baseRate);
      const sorted = [...g.list].sort((a, b) => (b.feedback.rated_at || '').localeCompare(a.feedback.rated_at || ''));
      return {
        id: g.id,
        name: g.name,
        n: g.n,
        k: g.k,
        unhappy: g.list.filter(isUnhappy).length,
        rawRate: g.k / g.n,
        adjRate: post.mean,
        lo: post.lo,
        hi: post.hi,
        probWorse: post.probAbove,
        flag: post.probAbove > 0.9 && g.n >= 5 ? 'worse' : post.probAbove < 0.1 && g.n >= 10 ? 'better' : null,
        // Most useful for coaching: the latest critical comment, else the latest comment.
        lastComment: (sorted.find((r) => isDissatisfied(r) && r.feedback.comment?.trim()) || sorted.find((r) => r.feedback.comment?.trim()))?.feedback.comment?.trim(),
      } as CleanerScore;
    })
    .sort((a, b) => b.adjRate - a.adjRate);
}

// ---------- Comments ----------

export const THEMES: { key: string; label: string; re: RegExp }[] = [
  { key: 'missed', label: 'Missed spots / not thorough', re: /\b(miss(ed|ing)?|forg[eo]t|didn'?t (clean|do|wipe|vacuum|mop)|not (clean|done|thorough)|dust(y)?|dirty|still|skipp?ed|overlook|left (over|behind)|streak|hair|crumbs?|sticky|grime|stain)/i },
  { key: 'time', label: 'Rushed / time & duration', re: /\b(rush(ed)?|hurr(y|ied)|quick(ly)?|short|left early|only (spent|stayed)|hours?|minutes?|time)\b/i },
  { key: 'late', label: 'Late / punctuality / no-show', re: /\b(late|on time|arriv|no.?show|didn'?t show|wait(ed|ing)|punctual|delay)/i },
  { key: 'communication', label: 'Communication', re: /\b(communicat|call(ed)?|text(ed)?|email|respond|repl(y|ied)|inform|notif|told|contact|english|language)/i },
  { key: 'damage', label: 'Damage / breakage', re: /\b(broke|broken|damag|scratch|crack|ruin|stain(ed)? (my|the)|spill)/i },
  { key: 'privacy', label: 'Privacy / trust / security', re: /\b(photo|video|picture|privacy|consent|camera|steal|stole|missing|lock(ed)?|key|alarm|trust)/i },
  { key: 'products', label: 'Products / supplies / smell', re: /\b(product|chemical|smell|scent|bleach|supplies|vacuum cleaner|equipment|cloth|mop)\b/i },
  { key: 'staff', label: 'Cleaner change / consistency', re: /\b(previous|usual|regular|same (cleaner|person|team)|new (cleaner|girl|lady|person)|different (cleaner|person)|replace|switch|change(d)? (the )?cleaner)/i },
  { key: 'price', label: 'Price / billing', re: /\b(price|charg|cost|expens|bill|refund|fee|money|paid|pay)\b/i },
  { key: 'praise', label: 'Praise (friendly, great job)', re: /\b(great|excellent|amazing|wonderful|fantastic|thank|friendly|lovely|awesome|perfect|spotless|happy|pleased|recommend)/i },
];

export function themeStats(rows: RatedBooking[]) {
  const withText = rows.filter((r) => r.feedback.comment?.trim());
  return THEMES.map((t) => {
    const hits = withText.filter((r) => t.re.test(r.feedback.comment!));
    const dis = hits.filter(isDissatisfied);
    return {
      ...t,
      n: hits.length,
      share: withText.length ? hits.length / withText.length : 0,
      dissatisfiedShare: hits.length ? dis.length / hits.length : 0,
      ofComplaints: withText.filter(isDissatisfied).length ? dis.length / withText.filter(isDissatisfied).length : 0,
      examples: dis.slice(0, 3).map((r) => r.feedback.comment!.trim()),
    };
  }).sort((a, b) => b.ofComplaints - a.ofComplaints || b.n - a.n);
}

const STOP = new Set(
  'a an and are as at be been but by for from had has have he her his i if in into is it its just me my no not of on or our she so that the their them then there they this to too us very was we were what when which who will with you your all also am any can could did do does dont got get one out up would been more about after again than only im ive were weve thats its theyre home house job time cleaner cleaners cleaning clean team service visit today she he her him lady girl'.split(' '),
);
const tokens = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length > 2 && !STOP.has(w));

/** Words that most distinguish dissatisfied comments from happy ones (log-odds z-scores). */
export function distinctiveWords(rows: RatedBooking[], top = 12) {
  const A = new Map<string, number>();
  const B = new Map<string, number>();
  for (const r of rows) {
    if (!r.feedback.comment?.trim()) continue;
    const target = isDissatisfied(r) ? A : B;
    for (const w of new Set(tokens(r.feedback.comment))) target.set(w, (target.get(w) || 0) + 1);
  }
  const prior = new Map<string, number>();
  for (const m of [A, B]) for (const [w, c] of m) prior.set(w, (prior.get(w) || 0) + c);
  for (const [w, c] of prior) if (c < 3) prior.delete(w);
  const z = logOddsZ(A, B, prior, 0.05);
  const list = [...z.entries()].map(([word, score]) => ({ word, score, a: A.get(word) || 0, b: B.get(word) || 0 }));
  return {
    complaints: list.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, top),
    praise: list.filter((x) => x.score < 0).sort((a, b) => a.score - b.score).slice(0, top),
  };
}

// ---------- Trend (p-chart) ----------

export function weeklyControl(rows: RatedBooking[]) {
  const weekOf = (iso: string) => {
    const d = new Date(iso);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  };
  const map = new Map<string, { n: number; k: number }>();
  for (const r of rows) {
    const w = weekOf(r.service_date || r.feedback.rated_at || '');
    const c = map.get(w) || { n: 0, k: 0 };
    c.n += 1;
    c.k += isDissatisfied(r) ? 1 : 0;
    map.set(w, c);
  }
  const N = rows.length;
  const pbar = N ? rows.filter(isDissatisfied).length / N : 0;
  return {
    pbar,
    weeks: [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, { n, k }]) => {
        const sigma = Math.sqrt((pbar * (1 - pbar)) / n);
        const ucl = Math.min(1, pbar + 3 * sigma);
        return { week, n, k, rate: k / n, ucl, lcl: Math.max(0, pbar - 3 * sigma), out: k / n > ucl };
      }),
  };
}

// ---------- Customers ----------

export function customersAtRisk(rows: RatedBooking[]) {
  const map = new Map<number, RatedBooking[]>();
  for (const r of rows) if (r.user?.id) map.set(r.user.id, [...(map.get(r.user.id) || []), r]);
  return [...map.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => (b.feedback.rated_at || '').localeCompare(a.feedback.rated_at || ''));
      const latest = sorted[0];
      const dis = list.filter(isDissatisfied).length;
      return { latest, ratings: list.length, dissatisfied: dis, recurring: freqGroup(latest.frequency?.name) !== 'One-time', annual: annualValue(latest) };
    })
    .filter((c) => isDissatisfied(c.latest))
    .sort((a, b) => b.annual - a.annual);
}

// ---------- Plain-English insights ----------

export interface Insight {
  tone: 'bad' | 'good' | 'info';
  text: string;
}

export function insights(args: {
  rows: RatedBooking[];
  prev?: RatedBooking[];
  drivers: Driver[];
  baseRate: number;
  cleaners: CleanerScore[];
  themes: ReturnType<typeof themeStats>;
  control: ReturnType<typeof weeklyControl>;
  atRisk: ReturnType<typeof customersAtRisk>;
  completed?: number;
}): Insight[] {
  const { rows, prev, drivers, baseRate, cleaners, themes, control, atRisk, completed } = args;
  const out: Insight[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const k = rows.filter(isDissatisfied).length;
  const [lo, hi] = wilson(k, rows.length);

  if (prev && prev.length >= 20) {
    const pk = prev.filter(isDissatisfied).length;
    const t = twoProportion(k, rows.length, pk, prev.length);
    const dir = t.diff > 0 ? 'up' : 'down';
    out.push({
      tone: t.pValue < 0.05 ? (t.diff > 0 ? 'bad' : 'good') : 'info',
      text: `Dissatisfaction is ${pct(baseRate)} (95% CI ${pct(lo)}–${pct(hi)}), ${dir} from ${pct(t.p2)} in the previous period${t.pValue < 0.05 ? ' — a statistically significant change.' : ' — within normal variation (not significant).'}`,
    });
  } else out.push({ tone: 'info', text: `Dissatisfaction is ${pct(baseRate)} (95% CI ${pct(lo)}–${pct(hi)}) across ${rows.length} ratings.` });

  const worse = drivers.filter((d) => d.significant && d.rate > d.rateWithout).sort((a, b) => b.ratio - a.ratio);
  for (const d of worse.slice(0, 3)) {
    out.push({
      tone: 'bad',
      text: `${d.label}: ${pct(d.rate)} dissatisfied vs ${pct(d.rateWithout)} without (${d.ratio.toFixed(1)}×${d.adjOdds ? `, ${d.adjOdds.toFixed(1)}× odds after controlling for other factors` : ''}; ${d.n} ratings).`,
    });
  }
  const better = drivers.filter((d) => d.significant && d.rate < d.rateWithout).sort((a, b) => a.ratio - b.ratio);
  for (const d of better.slice(0, 2)) out.push({ tone: 'good', text: `${d.label}: only ${pct(d.rate)} dissatisfied vs ${pct(d.rateWithout)} otherwise (${d.n} ratings).` });
  const confounded = drivers.filter((d) => d.verdict === 'raw' && d.rate > d.rateWithout).sort((a, b) => b.ratio - a.ratio);
  if (confounded.length)
    out.push({
      tone: 'info',
      text: `Look worse at first glance but mostly explained by other factors (e.g. one-time jobs, price): ${confounded
        .slice(0, 4)
        .map((d) => `${d.label} (${pct(d.rate)} raw, ${d.adjOdds?.toFixed(1)}× adjusted)`)
        .join(', ')}. Fix the underlying factor rather than the add-on itself.`,
    });
  if (!worse.length && !better.length) out.push({ tone: 'info', text: 'No factor stands out with statistical confidence yet — differences seen so far could be chance. Widen the period for more power.' });

  const flagged = cleaners.filter((c) => c.flag === 'worse');
  if (flagged.length)
    out.push({
      tone: 'bad',
      text: `${flagged.length} cleaner${flagged.length > 1 ? 's are' : ' is'} very likely (>90%) below company average after adjusting for small samples: ${flagged
        .slice(0, 4)
        .map((c) => `${c.name} (${c.k}/${c.n})`)
        .join(', ')}.`,
    });
  const stars = cleaners.filter((c) => c.flag === 'better');
  if (stars.length) out.push({ tone: 'good', text: `Consistently strong: ${stars.slice(0, 4).map((c) => c.name).join(', ')} — candidates for premium clients or training others.` });

  const topComplaint = themes.find((t) => t.key !== 'praise' && t.ofComplaints > 0);
  if (topComplaint) out.push({ tone: 'bad', text: `Most common complaint theme: “${topComplaint.label}” — in ${pct(topComplaint.ofComplaints)} of critical comments.` });

  const outWeeks = control.weeks.filter((w) => w.out);
  if (outWeeks.length) out.push({ tone: 'bad', text: `Abnormal week${outWeeks.length > 1 ? 's' : ''} (above the 3σ control limit): ${outWeeks.map((w) => `${w.week} (${w.k}/${w.n})`).join(', ')}. Look for a cause — staffing, a new cleaner, a process change.` });

  const recurringRisk = atRisk.filter((c) => c.recurring);
  if (recurringRisk.length)
    out.push({
      tone: 'bad',
      text: `${recurringRisk.length} recurring customer${recurringRisk.length > 1 ? 's' : ''} whose latest rating was negative — about $${Math.round(recurringRisk.reduce((s, c) => s + c.annual, 0)).toLocaleString()} a year at risk. Call them first (Customers tab).`,
    });

  if (completed) out.push({ tone: 'info', text: `Only ${pct(rows.length / completed)} of completed visits are rated. More responses (e.g. an automatic text after each visit) would make every number here sharper.` });
  return out;
}
