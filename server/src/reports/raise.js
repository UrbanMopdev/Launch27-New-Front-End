// Raise readiness: pure functions. Reliability (drops, no-shows, missing check-ins), pay rate
// history, assignability, and the verdict. Thresholds live in raise-config.js.
import { addDays, daysBetween, weekday } from '../schedule/rules.js';
import { CHANGE_LOG_START, DROP_REASONS, EMPLOYEE_TAG, LADDER, RAISE_THRESHOLDS, RESTRICTIVE_TAGS } from './raise-config.js';

const HOUR = 3_600_000;
const TZ_PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// The moment a Toronto wall-clock time happens (date 'YYYY-MM-DD', minutes after midnight).
export function torontoInstant(date, minutes = 9 * 60) {
  const naive = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  const parts = Object.fromEntries(TZ_PARTS.formatToParts(new Date(naive)).map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return naive - (asLocal - naive);
}

// ---------- drops and reliability ----------
// One drop: a cleaner taken off an assigned visit. kind by who and how much notice.
export function classifyDrop({ visit_at, dropped_at, reason }) {
  const r = reason ? DROP_REASONS[reason] : null;
  const lead = (Date.parse(visit_at) - Date.parse(dropped_at)) / HOUR;
  if (!r) return { kind: 'uncoded', lead_hours: Math.round(lead) };
  if (!r.cleaner) return { kind: 'not_cleaner', lead_hours: Math.round(lead) };
  if (r.noShow) return { kind: 'no_show', lead_hours: Math.round(lead) };
  if (lead < 24) return { kind: 'last_minute', lead_hours: Math.round(lead) };
  if (lead < 72) return { kind: 'short_notice', lead_hours: Math.round(lead) };
  return { kind: 'notice', lead_hours: Math.round(lead) };
}

export const INCIDENT_LABEL = {
  no_show: 'No-show',
  last_minute: 'Last-minute cancellation',
  short_notice: 'Short-notice drop',
  notice: 'Dropped with notice',
  missing_checkin: 'Missing check-in',
  missing_checkout: 'Missing check-out',
  late: 'Late arrival',
  uncoded: 'Taken off a visit, no reason yet',
  not_cleaner: 'Taken off a visit (not their doing)',
};

// Reliability over [from, to]. drops: rows for this cleaner (visit_at, dropped_at, reason,
// customer). checks: { missing: [{date, customer, kind}], late: [{date, customer, late}] }.
// Drops are only known from CHANGE_LOG_START on; before that, counts are null ("—").
export function reliability({ drops = [], checks = { missing: [], late: [] }, from, to, T = RAISE_THRESHOLDS, logStart = CHANGE_LOG_START }) {
  const known = to >= logStart;
  const coversFrom = from > logStart ? from : logStart;
  const inWindow = drops
    .map((d) => ({ ...d, date: String(d.dropped_on || d.dropped_at).slice(0, 10) }))
    .filter((d) => d.date >= coversFrom && d.date <= to)
    .sort((a, b) => Date.parse(a.dropped_at) - Date.parse(b.dropped_at));
  const incidents = [];
  let forgiven = null;
  const counts = { no_show: 0, last_minute: 0, short_notice: 0, notice: 0, sick: 0, uncoded: 0 };
  const cleanerDrops = [];
  for (const d of inWindow) {
    const c = classifyDrop(d);
    const sick = d.reason === 'cleaner_sick';
    let counted = ['no_show', 'last_minute', 'short_notice'].includes(c.kind);
    // A one-off sick day isn't penalised.
    if (counted && sick && T.forgiveFirstSickDay && !forgiven && c.kind !== 'no_show') {
      forgiven = d;
      counted = false;
    }
    if (sick) counts.sick++;
    if (c.kind === 'uncoded') counts.uncoded++;
    if (DROP_REASONS[d.reason]?.cleaner) cleanerDrops.push(d);
    if (counted) counts[c.kind]++;
    else if (c.kind === 'notice') counts.notice++;
    incidents.push({
      date: d.date,
      visit_date: String(d.visit_date || '').slice(0, 10) || null,
      customer: d.customer || null,
      kind: c.kind,
      label: INCIDENT_LABEL[c.kind],
      reason: d.reason ? DROP_REASONS[d.reason]?.label || d.reason : null,
      lead_hours: c.lead_hours,
      counted,
      note: forgiven === d ? 'one-off sick day, not counted' : null,
      id: d.id ?? null,
    });
  }
  for (const m of checks.missing || []) incidents.push({ date: m.date, visit_date: m.date, customer: m.customer, kind: m.kind, label: INCIDENT_LABEL[m.kind], reason: null, lead_hours: null, counted: true, note: null, id: null });
  for (const l of checks.late || []) incidents.push({ date: l.date, visit_date: l.date, customer: l.customer, kind: 'late', label: INCIDENT_LABEL.late, reason: `${l.late} min late`, lead_hours: null, counted: false, note: null, id: null });
  incidents.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const monFri = cleanerDrops.filter((d) => [1, 5].includes(weekday(String(d.visit_date || d.date).slice(0, 10)))).length;
  const pattern = cleanerDrops.length >= T.patternDrops ? `${cleanerDrops.length} cleaner-initiated drops` : monFri >= T.patternMonFri ? `${monFri} Monday/Friday drops` : null;
  const missingN = (checks.missing || []).length;
  return {
    known,
    covers_from: known ? coversFrom : null,
    partial: known && from < logStart,
    no_shows: known ? counts.no_show : null,
    last_minute: known ? counts.last_minute : null,
    short_notice: known ? counts.short_notice : null,
    with_notice: known ? counts.notice : null,
    sick_days: known ? counts.sick : null,
    uncoded: known ? counts.uncoded : null,
    missing_checks: missingN,
    late: (checks.late || []).length,
    pattern: known ? pattern : null,
    // The scorecard's Reliability count: everything that counts against them.
    issues: (known ? counts.no_show + counts.last_minute + counts.short_notice : 0) + missingN,
    incidents,
  };
}

// Weeks for the reliability strip: issues per week, or null before the change log starts.
export function reliabilityWeeks(rel, from, to, logStart = CHANGE_LOG_START) {
  const out = [];
  for (let w = from; w <= to; w = addDays(w, 7)) {
    const end = addDays(w, 6);
    const drops = end < logStart ? null : rel.incidents.filter((i) => i.counted && !['missing_checkin', 'missing_checkout'].includes(i.kind) && i.date >= w && i.date <= end).length;
    const missing = rel.incidents.filter((i) => ['missing_checkin', 'missing_checkout'].includes(i.kind) && i.date >= w && i.date <= end).length;
    out.push({ week: w, drops, missing });
  }
  return out;
}

// ---------- pay rate ----------
// From each visit's pay rate (Launch27 team share, $/h): current rate, when it last changed and
// from what. A new rate must hold for 2+ visits to count as a change (one-off adjustments don't).
export function rateHistory(points) {
  const pts = points.filter((p) => p.rate != null && Number.isFinite(p.rate)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!pts.length) return null;
  const runs = [];
  for (const p of pts) {
    const last = runs.at(-1);
    if (last && last.rate === p.rate) last.n++;
    else runs.push({ rate: p.rate, from: p.date, n: 1 });
  }
  const steady = runs.filter((r, i) => r.n >= 2 || i === runs.length - 1 || i === 0);
  const merged = [];
  for (const r of steady) {
    if (merged.length && merged.at(-1).rate === r.rate) continue;
    merged.push(r);
  }
  const cur = merged.at(-1);
  const prev = merged.length > 1 ? merged.at(-2) : null;
  return { current: cur.rate, since: cur.from, previous: prev ? prev.rate : null, changed_on: prev ? cur.from : null, first_seen: pts[0].date };
}

// ---------- profile ----------
export function restrictiveTags(tags = []) {
  const hits = [];
  for (const t of tags) {
    const rule = RESTRICTIVE_TAGS.find((r) => r.re.test(t));
    if (rule) hits.push({ tag: t, kind: rule.label });
  }
  return hits;
}

export function ladderOf(tags = []) {
  if (!tags.some((t) => EMPLOYEE_TAG.test(t))) return null;
  let i = 0;
  for (let k = LADDER.length - 1; k > 0; k--) if (tags.some((t) => new RegExp(`\\b${LADDER[k]}\\b`, 'i').test(t))) { i = k; break; }
  return { role: LADDER[i], next: LADDER[i + 1] || null };
}

export const monthsBetween = (a, b) => daysBetween(a, b) / 30.44;

// ---------- the verdict ----------
const fmtPct = (x) => `${Math.round(x * 100)}%`;
const grade3 = (x, ready, watch, higherIsBetter = true) => {
  if (x == null) return 'neutral';
  if (higherIsBetter) return x >= ready ? 'ready' : x >= watch ? 'watch' : 'not_yet';
  return x <= ready ? 'ready' : x <= watch ? 'watch' : 'not_yet';
};

// Grades every factor. m: the cleaner's 13-week figures (see service.js raiseInput).
export function gradeFactors(m, T = RAISE_THRESHOLDS) {
  const f = [];
  const add = (key, label, grade, value, need, link = null, extra = {}) => f.push({ key, label, grade, value, need: grade === 'ready' || grade === 'neutral' ? null : need, link, ...extra });

  // Tenure
  const months = m.start_date ? monthsBetween(m.start_date, m.today) : null;
  const mo = months == null ? null : Math.floor(months);
  add('tenure', 'Tenure', grade3(months, T.tenureMonths.ready, T.tenureMonths.watch), months == null ? 'unknown' : `${m.start_known ? '' : 'at least '}${mo} month${mo === 1 ? '' : 's'}`,
    months == null ? null : `${Math.max(1, Math.ceil(T.tenureMonths.ready - months))}+ more month${Math.ceil(T.tenureMonths.ready - months) === 1 ? '' : 's'}`);

  // Rating: Happy % or Launch27 stars, whichever is better; say which.
  const happyGrade = !m.rated ? null : m.happy >= T.happy.ready ? (m.rated >= T.happy.minRated ? 'ready' : 'watch') : m.happy >= T.happy.watch ? 'watch' : 'not_yet';
  const starGrade = !m.stars_count || m.stars == null ? null : m.stars >= T.stars.ready ? (m.stars_count >= T.stars.minCount ? 'ready' : 'watch') : m.stars >= T.stars.watch ? 'watch' : 'not_yet';
  const rank = { ready: 3, watch: 2, not_yet: 1 };
  const useStars = starGrade && (!happyGrade || rank[starGrade] > rank[happyGrade]);
  const ratingGrade = useStars ? starGrade : happyGrade || 'watch';
  const happyText = m.rated ? `Happy ${fmtPct(m.happy)} of ${m.rated}` : 'No Happy ratings';
  const starText = m.stars_count ? `${m.stars.toFixed(2)}★ (${m.stars_count})` : null;
  add('rating', 'Rating', ratingGrade, useStars ? `${starText} L27 stars` : happyText,
    `Happy ≥ ${fmtPct(T.happy.ready)} over ${T.happy.minRated}+ ratings`, 'ratings', { uses: useStars ? 'stars' : 'happy', other: useStars ? happyText : starText });

  add('on_time', 'On time', m.tracked ? grade3(m.on_time, T.onTime.ready, T.onTime.watch) : 'neutral', m.tracked ? `${fmtPct(m.on_time)} of ${m.tracked}` : 'no check-ins', `On time ≥ ${fmtPct(T.onTime.ready)}`, 'time-tracking');

  const r = m.reliability;
  add('no_shows', 'No-shows', !r.known ? 'neutral' : r.no_shows ? 'not_yet' : 'ready', r.known ? String(r.no_shows) : '—', 'No no-shows for 13 weeks', 'reliability');
  add('last_minute', 'Last-minute cancellations', !r.known ? 'neutral' : grade3(r.last_minute, T.lastMinute.ready, T.lastMinute.watch, false), r.known ? String(r.last_minute) : '—', 'No last-minute cancellations', 'reliability');
  const sn = (r.short_notice || 0) + (r.missing_checks || 0);
  let snGrade = grade3(sn, T.shortNotice.ready, T.shortNotice.watch, false);
  if (r.pattern) snGrade = 'not_yet';
  add('short_notice', 'Short-notice drops + missing check-ins', snGrade, `${r.known ? r.short_notice : '—'} + ${r.missing_checks}${r.pattern ? ` · pattern: ${r.pattern}` : ''}`, `At most ${T.shortNotice.ready} short-notice drop or missing check-in${r.pattern ? ', and no pattern of drops' : ''}`, 'reliability');

  add('finished_early', 'Finished early', m.residential ? grade3(m.early_share, T.finishedEarly.ready, T.finishedEarly.watch, false) : 'neutral', m.residential ? `${fmtPct(m.early_share)} of ${m.residential} residential` : 'no residential visits', `Finishes early on < ${fmtPct(T.finishedEarly.ready)} of visits`, 'time-tracking');
  add('complaints', 'Complaints / re-cleans', m.complaints == null ? 'neutral' : grade3(m.complaints, T.complaints.ready, T.complaints.watch, false), m.complaints == null ? '—' : String(m.complaints), 'No complaints for 13 weeks', 'inbox');
  add('keeps', 'Keeps clients', m.clients_started ? grade3(m.keeps, T.keeps.ready, T.keeps.watch) : 'neutral', m.clients_started ? `${fmtPct(m.keeps)} of ${m.clients_started}` : 'no regular clients', `Keeps ≥ ${fmtPct(T.keeps.ready)} of regular clients`);
  add('hours', 'Hours', grade3(m.hours_per_week, T.hoursPerWeek.ready, T.hoursPerWeek.watch), m.hours_per_week == null ? '—' : `${Math.round(m.hours_per_week)}/wk`, `${T.hoursPerWeek.ready}+ hours a week`);
  const nTags = m.restrictive.length;
  add('assignability', 'Assignability', grade3(nTags, T.restrictiveTags.ready, T.restrictiveTags.watch, false), `${nTags} restrictive tag${nTags === 1 ? '' : 's'}`, `At most ${T.restrictiveTags.ready} restrictive tags`);
  // Google reviews: a bonus only, never a fail.
  const g = m.google_reviews || 0;
  add('google', 'Google reviews', g >= T.googleReviews.ready ? 'ready' : 'neutral', String(g), null);
  return f;
}

// The verdict from graded factors. Returns { verdict, label, reasons }.
export function decide(factors, m, T = RAISE_THRESHOLDS) {
  const by = Object.fromEntries(factors.map((x) => [x.key, x]));
  const notYet = factors.filter((x) => x.grade === 'not_yet');
  const thinRatings = m.rated_share != null && m.rated_share < T.thinRatingShare;
  const ready = factors.filter((x) => x.grade === 'ready' && !(thinRatings && x.key === 'rating'));
  const gates = [];
  if (m.reliability.known && m.reliability.no_shows > 0) gates.push(`${m.reliability.no_shows} no-show${m.reliability.no_shows === 1 ? '' : 's'}`);
  if (m.reliability.known && m.reliability.last_minute >= T.gateLastMinute) gates.push(`${m.reliability.last_minute} last-minute cancellations`);
  let verdict;
  if (gates.length || notYet.length >= T.notYetFactors) verdict = 'not_yet';
  else if (!notYet.length && ready.length >= T.readyFactorsNeeded) verdict = 'ready';
  else verdict = 'watch';
  return { verdict, gates, ready_count: ready.length, not_yet_count: notYet.length, thin_ratings: thinRatings, on_time_gate: by.on_time?.grade === 'not_yet' };
}

export const VERDICT_LABEL = { ready: 'Ready', watch: 'Watch', not_yet: 'Not yet', thin: '—', ceiling: 'At ceiling', ladder: 'Ladder' };

// Everything the panel and the scorecard need.
export function raiseReview(m, T = RAISE_THRESHOLDS) {
  const factors = gradeFactors(m, T);
  const d = decide(factors, m, T);
  const thin = m.visits < T.minVisits || m.rated < T.minRated;
  let verdict = d.verdict;
  let override = null;
  if (m.ladder) override = 'ladder';
  else if (m.rate != null && m.rate >= T.ceilingRate) override = 'ceiling';
  else if (thin) override = 'thin';
  const shown = override || verdict;
  const reReview = override === 'ladder' || override === 'ceiling' ? null : override === 'thin' ? addDays(m.today, T.reReviewDays.watch) : T.reReviewDays[verdict] ? addDays(m.today, T.reReviewDays[verdict]) : null;
  const toReady = factors.filter((x) => x.need && (x.grade === 'not_yet' || x.grade === 'watch')).map((x) => x.need);
  return {
    verdict: shown,
    label: override === 'ladder' ? m.ladder.role : VERDICT_LABEL[shown],
    underlying: verdict,
    thin,
    thin_reason: thin ? `${m.visits} visits and ${m.rated} rated in 13 weeks (needs ${T.minVisits}+ and ${T.minRated}+)` : null,
    gates: d.gates,
    ready_count: d.ready_count,
    thin_ratings: d.thin_ratings,
    factors,
    to_ready: verdict === 'ready' ? [] : toReady,
    re_review: reReview,
    ladder: m.ladder,
  };
}

// 3–4 plain-text lines for Slack (copied to the clipboard; the app never posts).
export function slackSummary({ name, review, rate, from, to }) {
  const money = (x) => (x == null ? null : `$${Number(x).toFixed(2)}`);
  const date = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const verdictText = review.verdict === 'ladder' ? `${review.ladder.role}${review.ladder.next ? ` (next step: ${review.ladder.next})` : ''}` : review.verdict === 'thin' ? 'Not enough data yet' : review.label;
  const lines = [`Raise review: ${name}: ${verdictText} (13 weeks, ${date(from)} to ${date(to)})`];
  if (rate) lines.push(`Current rate ${money(rate.current)}/h since ${date(rate.since)}${rate.previous != null ? `, was ${money(rate.previous)}` : ', no change in the last 12 months'}.`);
  const bad = review.factors.filter((f) => f.grade === 'not_yet').map((f) => `${f.label} ${f.value}`);
  const watch = review.factors.filter((f) => f.grade === 'watch').map((f) => `${f.label} ${f.value}`);
  const good = review.factors.filter((f) => f.grade === 'ready' && f.key !== 'google').map((f) => `${f.label} ${f.value}`);
  const deciding = review.gates.length ? `Blocked by ${review.gates.join(', ')}.` : bad.length ? `Holding back: ${bad.join('; ')}.` : watch.length ? `To watch: ${watch.join('; ')}.` : `Strong on: ${good.slice(0, 4).join('; ')}.`;
  lines.push(review.thin ? review.thin_reason + '.' : deciding);
  if (review.re_review) lines.push(`Re-review ${date(review.re_review)}.`);
  return lines.join('\n');
}
