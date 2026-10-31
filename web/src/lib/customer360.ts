import type { Booking } from '../types';
import type { RatedBooking } from './feedbackModel';

// Everything the Customer 360 says about a customer, worked out from Launch27 bookings.
// Pure functions so the page logic is testable.

const DAY = 86_400_000;
const MIN = 60_000;

export type Stage = 'booked' | 'enroute' | 'arrived' | 'done';

export interface VisitStatus {
  stage: Stage;
  enrouteAt?: string;
  checkinAt?: string;
  checkoutAt?: string;
  windowStart: number; // ms
  windowEnd: number; // ms
  // Something the office should act on, from the cleaner's en route / check-in times.
  risk: null | { kind: 'not_enroute' | 'not_checked_in' | 'late_checkin'; label: string };
}

export function visitStatus(b: Booking, now = Date.now()): VisitStatus {
  const t = b.time_tracking?.[0];
  const windowStart = b.service_date ? new Date(b.service_date).getTime() : now;
  const windowEnd = windowStart + (Number(b.arrival_window) || 0) * MIN;
  const stage: Stage = t?.checkout_at ? 'done' : t?.checkin_at ? 'arrived' : t?.enroute_started_at ? 'enroute' : 'booked';
  let risk: VisitStatus['risk'] = null;
  if (stage === 'booked' && now > windowStart) {
    risk = { kind: 'not_enroute', label: 'Not en route yet' };
  } else if (stage === 'enroute' && now > windowEnd - 15 * MIN) {
    risk = { kind: 'not_checked_in', label: now > windowEnd ? `Not checked in, ${Math.round((now - windowEnd) / MIN)} min past window` : 'Not checked in' };
  } else if (t?.checkin_at && new Date(t.checkin_at).getTime() > windowEnd + 5 * MIN) {
    risk = { kind: 'late_checkin', label: `Arrived ${Math.round((new Date(t.checkin_at).getTime() - windowEnd) / MIN)} min after window` };
  }
  return { stage, enrouteAt: t?.enroute_started_at, checkinAt: t?.checkin_at, checkoutAt: t?.checkout_at, windowStart, windowEnd, risk };
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

// Today's visit that is still in play: not yet checked out, or finished in the last 90 minutes.
export function liveVisit(bookings: Booking[], now = Date.now()): Booking | null {
  const today = bookings
    .filter((b) => b.active !== false && b.service_date && sameDay(new Date(b.service_date).getTime(), now))
    .sort((a, b) => String(a.service_date).localeCompare(String(b.service_date)));
  for (const b of today) {
    const s = visitStatus(b, now);
    if (s.stage === 'done' && s.checkoutAt && now - new Date(s.checkoutAt).getTime() > 90 * MIN) continue;
    if (s.stage === 'booked' && now < s.windowStart - 2 * 60 * MIN) continue; // later today: still "next visit"
    return b;
  }
  return null;
}

// Typical days between visits (median of recent gaps), or null with too little history.
export function rhythmDays(past: Booking[]): number | null {
  const dates = past
    .map((b) => (b.service_date ? new Date(b.service_date).getTime() : NaN))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => b - a)
    .slice(0, 9);
  if (dates.length < 3) return null;
  const gaps = dates.slice(1).map((d, i) => (dates[i] - d) / DAY).sort((a, b) => a - b);
  return Math.round(gaps[Math.floor(gaps.length / 2)]);
}

export function rhythmLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days <= 8) return 'Weekly';
  if (days <= 16) return 'Every 2 weeks';
  if (days <= 24) return 'Every 3 weeks';
  if (days <= 35) return 'Monthly';
  return `About every ${Math.round(days / 7)} weeks`;
}

export type RatingDot = 'happy' | 'okay' | 'unhappy' | 'none';

// The last n completed visits, oldest first, as rating dots.
export function ratingDots(past: RatedBooking[], n = 6): RatingDot[] {
  return [...past]
    .sort((a, b) => String(b.service_date).localeCompare(String(a.service_date)))
    .slice(0, n)
    .reverse()
    .map((b) => (!b.feedback ? 'none' : b.feedback.rating === 2 ? 'happy' : b.feedback.rating === 1 ? 'okay' : 'unhappy'));
}

export interface CleanerAffinity {
  id?: number;
  name: string;
  visits: number;
  happy: number;
  unhappy: number;
}

// Who has cleaned for this customer and how it went. Preferred = most happy visits with
// no unhappy ones (at least 2); avoid = rated unhappy and never happy.
export function cleanerAffinity(past: RatedBooking[]) {
  const map = new Map<string, CleanerAffinity>();
  for (const b of past) {
    for (const t of b.teams || []) {
      const key = String(t.id ?? t.title);
      const e = map.get(key) || { id: t.id, name: t.title || `Cleaner ${t.id}`, visits: 0, happy: 0, unhappy: 0 };
      e.visits++;
      if (b.feedback?.rating === 2) e.happy++;
      if (b.feedback?.rating === 0) e.unhappy++;
      map.set(key, e);
    }
  }
  const all = [...map.values()].sort((a, b) => b.visits - a.visits);
  const preferred = [...all].filter((c) => c.happy >= 2 && c.unhappy === 0).sort((a, b) => b.happy - a.happy)[0] || null;
  const avoid = all.filter((c) => c.unhappy > 0 && c.happy === 0);
  return { all, preferred, avoid };
}

export type CustomerState = 'live' | 'between' | 'lapsed' | 'new';

export interface Insights {
  state: CustomerState;
  live: Booking | null;
  next: Booking | null;
  last: RatedBooking | null;
  rhythm: number | null;
  daysSinceLast: number | null;
  overdue: boolean; // nothing booked and past twice their usual gap (or 45 days)
  spend: number;
  outstanding: number;
  completed: number;
  avg: number | null;
  lastRating: RatedBooking | null;
  unhappyRecently: boolean;
  dots: RatingDot[];
  cleaners: ReturnType<typeof cleanerAffinity>;
}

export function insights(past: RatedBooking[], upcoming: Booking[], now = Date.now()): Insights {
  const sortedPast = [...past].sort((a, b) => String(b.service_date).localeCompare(String(a.service_date)));
  const all = [...upcoming, ...sortedPast];
  const live = liveVisit(all, now);
  const next = upcoming.filter((b) => b.active !== false && b.id !== live?.id && b.service_date && new Date(b.service_date).getTime() > now - 2 * 60 * MIN).sort((a, b) => String(a.service_date).localeCompare(String(b.service_date)))[0] || null;
  const last = sortedPast[0] || null;
  const rhythm = rhythmDays(sortedPast);
  const daysSinceLast = last?.service_date ? Math.floor((now - new Date(last.service_date).getTime()) / DAY) : null;
  const spend = sortedPast.reduce((s, b) => s + (b.summary?.total || 0), 0);
  const outstanding = all.reduce((s, b) => s + (b.charges?.outstanding || 0), 0);
  const rated = sortedPast.filter((b) => b.feedback);
  const lastRating = rated[0] || null;
  const unhappyRecently = !!lastRating && lastRating.feedback.rating === 0 && now - new Date(lastRating.service_date || 0).getTime() < 90 * DAY;
  const state: CustomerState = live ? 'live' : next ? 'between' : sortedPast.length ? 'lapsed' : 'new';
  const overdue = state === 'lapsed' && daysSinceLast !== null && daysSinceLast > Math.max(rhythm ? rhythm * 2 : 45, 21);
  return {
    state,
    live,
    next,
    last,
    rhythm,
    daysSinceLast,
    overdue,
    spend,
    outstanding,
    completed: sortedPast.length,
    avg: sortedPast.length ? spend / sortedPast.length : null,
    lastRating,
    unhappyRecently,
    dots: ratingDots(sortedPast),
    cleaners: cleanerAffinity(sortedPast),
  };
}

const firstOf = (name?: string) => (name || '').split(' ')[0] || name || '';

// One plain-English sentence for the top of the page.
export function summarySentence(i: Insights, opts: { since?: string | null; city?: string | null; now?: number } = {}): { lead: string; emphasis: string | null } {
  const now = opts.now ?? Date.now();
  const parts: string[] = [];
  const rhythm = rhythmLabel(i.rhythm);
  const since = opts.since ? new Date(opts.since).getFullYear() : null;
  if (i.completed) parts.push(`${rhythm || 'Customer'}${since ? ` since ${since}` : ''}${opts.city ? ` in ${opts.city}` : ''}, ${i.completed} clean${i.completed === 1 ? '' : 's'}.`);
  else parts.push('New customer, no completed cleans yet.');
  const recentHappy = (() => {
    let n = 0;
    for (const d of [...i.dots].reverse()) {
      if (d === 'happy') n++;
      else if (d !== 'none') break;
    }
    return n;
  })();
  if (i.unhappyRecently) parts.push(`Last visit was rated Unhappy${i.lastRating?.feedback.comment ? ` ("${i.lastRating.feedback.comment}")` : ''}.`);
  else if (recentHappy >= 2) parts.push(`Happy with the last ${recentHappy} rated visits.`);
  if (i.cleaners.preferred) parts.push(`Prefers ${i.cleaners.preferred.name}.`);

  let emphasis: string | null = null;
  if (i.state === 'live' && i.live) {
    const s = visitStatus(i.live, now);
    const who = firstOf(i.live.teams?.[0]?.title) || 'The cleaner';
    const end = new Date(s.windowEnd).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    emphasis =
      s.stage === 'done' ? `Today's visit is done: ${who} checked out.`
      : s.stage === 'arrived' ? `${who} is there now.`
      : s.stage === 'enroute' ? (s.risk ? `${who} is en route but hasn't checked in, and the window ends at ${end}.` : `${who} is on the way.`)
      : s.risk ? `Today's visit: ${who} hasn't started en route yet.` : `Visit today with ${who}.`;
  } else if (i.state === 'between' && i.next) {
    const d = new Date(i.next.service_date || now);
    const days = Math.round((d.setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
    const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : new Date(i.next.service_date!).toLocaleDateString([], { weekday: 'long' });
    emphasis = `${i.unhappyRecently || i.outstanding > 0 ? '' : 'All good. '}Next visit is ${days > 6 ? new Date(i.next.service_date!).toLocaleDateString([], { month: 'short', day: 'numeric' }) : when}${i.next.teams?.[0]?.title ? ` with ${firstOf(i.next.teams[0].title)}` : ''}.`;
  } else if (i.state === 'lapsed') {
    emphasis = i.overdue ? `Nothing booked, and no visit in ${Math.round((i.daysSinceLast || 0) / 7)} weeks.` : 'Nothing booked yet.';
  }
  return { lead: parts.join(' '), emphasis };
}
