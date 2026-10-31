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
  if (parking && /^no/i.test(parking)) add('home:noparking', 'No parking at the home', 'Home');

  const fg = freqGroup(r.frequency?.name);
  add(`freq:${fg}`, fg, 'Frequency');
  if (/prepaid/i.test(r.frequency?.name || '')) add('freq:prepaid', 'Prepaid plan', 'Frequency');

  if (r.service_date) {
    const { hour, weekday } = localParts(r.service_date);
    if (hour >= 12) add('sched:afternoon', 'Afternoon visit', 'Scheduling');
    if (weekday === 'Sat' || weekday === 'Sun') add('sched:weekend', 'Weekend visit', 'Scheduling');
    if (r.created_at && new Date(r.service_date).getTime() - new Date(r.created_at).getTime() < 48 * 3_600_000) add('sched:lastminute', 'Last-minute booking (under 48 hours’ notice)', 'Scheduling');
  }
  if ((r.teams || []).length > 1) add('exec:multi', 'Two or more cleaners on the job', 'Execution');
  if (!(r.teams || []).length) add('exec:unassigned', 'No cleaner assigned', 'Execution');

  const ex = execution(r);
  if (ex.lateMin !== null && ex.lateMin > 10) add('exec:late', 'Cleaner arrived late', 'Execution');
  if (ex.ratio !== null && ex.ratio < 0.85) add('exec:short', 'Cleaner left well before the booked time', 'Execution');
  if (ex.ratio !== null && ex.ratio > 1.15) add('exec:long', 'Job ran well over the booked time', 'Execution');
  if (!(r.time_tracking || []).some((t) => t.checkin_at)) add('exec:notracking', 'Cleaner didn’t check in on the app', 'Execution');

  if ((r.summary?.total || 0) >= ctx.priceP75 && ctx.priceP75 > 0) add('price:top25', 'Most expensive jobs (top 25%)', 'Price');
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
//
// Written for execs and the people acting on them: what's happening, what to do, where to
// look. `math` holds the statistical detail, shown only when "Show the math" is on.

export interface Insight {
  tone: 'bad' | 'good' | 'info';
  title: string;
  action?: string;
  math?: string;
  tab?: 'drivers' | 'cleaners' | 'comments' | 'customers';
}

const ACTIONS: Record<string, string> = {
  'sched:lastminute': 'Send experienced cleaners to last-minute bookings, and do a quick call to confirm what the customer expects.',
  'exec:late': 'Tighten routing and start times; text the customer when a cleaner is running late.',
  'exec:short': 'Check the jobs that finished well under the booked time — set a minimum time on site or use the checklist sign-off.',
  'exec:long': 'Re-quote homes that keep running over; they may be underpriced or under-scoped.',
  'exec:multi': 'Assign a lead on two-cleaner jobs so the work is split clearly and nothing is missed.',
  'freq:One-time': 'Set expectations on first visits (what is and isn\'t included) and follow up the next day.',
  'home:pets': 'Add a pet-hair step to the checklist and bring the right vacuum attachments.',
  'home:baths3': 'Allow more time for larger homes when quoting.',
  'price:top25': 'High-value jobs need your best cleaners and a quality check.',
};
const actionFor = (d: Driver) =>
  ACTIONS[d.key] ||
  (d.group === 'Extras'
    ? `Review how “${d.label}” is done — add it to the checklist with clear steps and enough time.`
    : d.group === 'Location'
      ? `Look at staffing and supervision in ${d.label}.`
      : `Look into jobs with “${d.label}” to find what's going wrong.`);

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
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const inTen = (x: number) => Math.max(1, Math.round(x * 10));
  const k = rows.filter(isDissatisfied).length;
  const [lo, hi] = wilson(k, rows.length);

  // 1. Headline trend
  if (prev && prev.length >= 20) {
    const pk = prev.filter(isDissatisfied).length;
    const t = twoProportion(k, rows.length, pk, prev.length);
    const real = t.pValue < 0.05;
    out.push({
      tone: real ? (t.diff > 0 ? 'bad' : 'good') : 'info',
      title: real
        ? `${pct(baseRate)} of customers rated their visit okay or unhappy — ${t.diff > 0 ? 'up' : 'down'} from ${pct(t.p2)} last period. This is a real ${t.diff > 0 ? 'decline' : 'improvement'}, not a blip.`
        : `${pct(baseRate)} of customers rated their visit okay or unhappy (${pct(t.p2)} last period). No real change.`,
      action: real && t.diff > 0 ? 'Use the cards below to find where it went wrong.' : undefined,
      math: `95% CI ${pct(lo)}–${pct(hi)}; two-proportion z-test p=${t.pValue.toFixed(3)} (n=${rows.length} vs ${prev.length}).`,
    });
  } else out.push({ tone: 'info', title: `${pct(baseRate)} of customers rated their visit okay or unhappy.`, math: `95% CI ${pct(lo)}–${pct(hi)}, n=${rows.length}.` });

  // 2. Proven problem factors
  const worse = drivers.filter((d) => d.significant && d.rate > d.rateWithout).sort((a, b) => b.ratio - a.ratio);
  for (const d of worse.slice(0, 3)) {
    out.push({
      tone: 'bad',
      title: `${d.label}: ${inTen(d.rate)} in 10 of these customers are not happy, vs ${inTen(d.rateWithout)} in 10 otherwise.`,
      action: actionFor(d),
      math: `${pct(d.rate)} vs ${pct(d.rateWithout)}, ${d.ratio.toFixed(1)}× raw; adjusted odds ${d.adjOdds?.toFixed(2)} (95% CI ${d.adjOddsCi?.map((x) => x.toFixed(2)).join('–')}); q=${d.qValue.toFixed(3)}; n=${d.n}.`,
      tab: 'drivers',
    });
  }

  // 3. Cleaners needing coaching
  const flagged = cleaners.filter((c) => c.flag === 'worse');
  if (flagged.length)
    out.push({
      tone: 'bad',
      title: `${flagged.length} cleaner${flagged.length > 1 ? 's get' : ' gets'} noticeably more complaints than the rest of the team: ${flagged
        .slice(0, 3)
        .map((c) => `${c.name.replace(/^(\([^)]*\))+/, '')} (${c.k} of ${c.n} ratings)`)
        .join(', ')}${flagged.length > 3 ? ` and ${flagged.length - 3} more` : ''}.`,
      action: 'Review their recent jobs with them, pair them with a top performer, or do a quality check on their next visits.',
      math: `Empirical-Bayes shrinkage; flagged when P(rate > company average) > 90% with ≥5 ratings.`,
      tab: 'cleaners',
    });

  // 4. Top complaint theme
  const topComplaint = themes.find((t) => t.key !== 'praise' && t.ofComplaints > 0);
  if (topComplaint)
    out.push({
      tone: 'bad',
      title: `The #1 complaint is “${topComplaint.label.toLowerCase()}” — it comes up in ${inTen(topComplaint.ofComplaints)} of every 10 negative comments.`,
      action: topComplaint.key === 'missed' ? 'Add the most-missed areas (kitchen, floors, baseboards) to the checklist and spot-check them.' : 'Read these comments (Comments tab) and brief the team on the pattern.',
      math: `${topComplaint.n} comments match this theme; ${pct(topComplaint.ofComplaints)} of okay/unhappy comments.`,
      tab: 'comments',
    });

  // 5. Unusual weeks
  const outWeeks = control.weeks.filter((w) => w.out);
  if (outWeeks.length)
    out.push({
      tone: 'bad',
      title: `Unusually bad week${outWeeks.length > 1 ? 's' : ''}: ${outWeeks.map((w) => `week of ${w.week}`).join(', ')}.`,
      action: 'Check what was different that week — new cleaners, sick calls, a schedule change.',
      math: `Above the 3σ p-chart upper control limit (${outWeeks.map((w) => `${w.k}/${w.n}`).join(', ')}).`,
    });

  // 6. Revenue at risk
  const recurringRisk = atRisk.filter((c) => c.recurring);
  if (recurringRisk.length)
    out.push({
      tone: 'bad',
      title: `${recurringRisk.length} regular customer${recurringRisk.length > 1 ? 's' : ''} left a negative rating last time — about $${Math.round(recurringRisk.reduce((s, c) => s + c.annual, 0) / 1000)}k a year of business.`,
      action: 'Call them this week, starting with the highest value. The list is ready to download.',
      math: 'Annual value = latest visit total × visits per year for their plan.',
      tab: 'customers',
    });

  // 7. Things that look bad but aren't the real cause
  const confounded = drivers.filter((d) => d.verdict === 'raw' && d.rate > d.rateWithout).sort((a, b) => b.ratio - a.ratio);
  if (confounded.length)
    out.push({
      tone: 'info',
      title: `${confounded
        .slice(0, 3)
        .map((d) => d.label)
        .join(', ')} look like problems, but mostly because they're often booked as one-time or bigger jobs.`,
      action: 'Don\'t drop these add-ons — fix how first-time and larger jobs are handled instead.',
      math: confounded.slice(0, 4).map((d) => `${d.label}: ${pct(d.rate)} raw, adjusted odds ${d.adjOdds?.toFixed(2)} (CI ${d.adjOddsCi?.map((x) => x.toFixed(2)).join('–')})`).join('; '),
      tab: 'drivers',
    });

  // 8. What's going well
  const better = drivers.filter((d) => d.significant && d.rate < d.rateWithout).sort((a, b) => a.ratio - b.ratio);
  for (const d of better.slice(0, 2))
    out.push({
      tone: 'good',
      title: `${d.label} customers are the happiest — only ${inTen(d.rate)} in 10 not happy, vs ${inTen(d.rateWithout)} in 10 otherwise.`,
      action: d.key.startsWith('freq:') ? 'Encourage one-time customers to switch to a regular plan.' : undefined,
      math: `${pct(d.rate)} vs ${pct(d.rateWithout)}; adjusted odds ${d.adjOdds?.toFixed(2)}; q=${d.qValue.toFixed(3)}.`,
      tab: 'drivers',
    });
  const stars = cleaners.filter((c) => c.flag === 'better');
  if (stars.length)
    out.push({
      tone: 'good',
      title: `Top performers: ${stars.slice(0, 4).map((c) => c.name.replace(/^(\([^)]*\))+/, '')).join(', ')} — consistently great ratings.`,
      action: 'Give them your most important clients, and have them train or shadow others.',
      tab: 'cleaners',
    });

  if (!worse.length && !confounded.length)
    out.push({ tone: 'info', title: 'Nothing stands out clearly yet — the differences so far could be chance.', action: 'Try a longer period for a clearer picture.' });

  if (completed)
    out.push({
      tone: 'info',
      title: `Only ${inTen(rows.length / completed) === 1 && rows.length / completed < 0.15 ? '1' : inTen(rows.length / completed)} in 10 visits get a rating.`,
      action: 'Send an automatic thank-you text with a rating link after each visit — more ratings make every number here more reliable.',
      math: `${rows.length} ratings / ${completed} completed visits = ${pct(rows.length / completed)}.`,
    });
  return out;
}
