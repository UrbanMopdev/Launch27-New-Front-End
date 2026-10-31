import { describe, expect, it } from 'vitest';
import type { Booking } from '../types';
import type { RatedBooking } from './feedbackModel';
import { cleanerAffinity, insights, liveVisit, ratingDots, rhythmDays, rhythmLabel, summarySentence, visitStatus } from './customer360';

const NOW = Date.parse('2026-11-02T18:34:00Z'); // 1:34 p.m. Toronto
const at = (iso: string) => iso;
const booking = (o: Partial<Booking>): Booking => ({ id: 1, active: true, arrival_window: 60, ...o });
const past = (date: string, rating: 0 | 1 | 2 | null, team = { id: 7, title: 'Quinn Clark' }, total = 200): RatedBooking =>
  ({ id: Date.parse(date), service_date: date, active: true, completed: true, teams: [team], summary: { total }, feedback: rating === null ? null : { stars: 5, rating } }) as unknown as RatedBooking;

describe('visitStatus', () => {
  const b = (tt: Booking['time_tracking']) => booking({ service_date: at('2026-11-02T18:00:00Z'), time_tracking: tt });
  it('reads the stage from the cleaner\'s taps', () => {
    expect(visitStatus(b([]), NOW).stage).toBe('booked');
    expect(visitStatus(b([{ enroute_started_at: '2026-11-02T18:22:00Z' }]), NOW).stage).toBe('enroute');
    expect(visitStatus(b([{ enroute_started_at: 'x', checkin_at: '2026-11-02T18:40:00Z' }]), NOW).stage).toBe('arrived');
    expect(visitStatus(b([{ checkin_at: 'x', checkout_at: 'y' }]), NOW).stage).toBe('done');
  });
  it('flags not en route once the window opens, and not checked in near its end', () => {
    expect(visitStatus(b([]), NOW).risk?.kind).toBe('not_enroute');
    expect(visitStatus(b([{ enroute_started_at: '2026-11-02T18:22:00Z' }]), NOW).risk).toBeNull(); // 26 min left
    expect(visitStatus(b([{ enroute_started_at: '2026-11-02T18:22:00Z' }]), Date.parse('2026-11-02T18:50:00Z')).risk?.kind).toBe('not_checked_in');
    expect(visitStatus(b([{ checkin_at: '2026-11-02T19:20:00Z' }]), NOW).risk?.label).toMatch(/Arrived 20 min after/);
  });
});

describe('liveVisit', () => {
  it('picks today\'s visit in play and skips ones finished long ago or much later today', () => {
    const later = booking({ id: 2, service_date: '2026-11-02T23:00:00Z' });
    const now1 = booking({ id: 3, service_date: '2026-11-02T18:00:00Z', time_tracking: [{ enroute_started_at: '2026-11-02T18:22:00Z' }] });
    expect(liveVisit([later, now1], NOW)?.id).toBe(3);
    expect(liveVisit([later], NOW)).toBeNull();
    const doneEarly = booking({ id: 4, service_date: '2026-11-02T13:00:00Z', time_tracking: [{ checkin_at: 'x', checkout_at: '2026-11-02T15:00:00Z' }] });
    expect(liveVisit([doneEarly], NOW)).toBeNull();
  });
});

describe('rhythm, dots and cleaners', () => {
  const weekly = ['2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05', '2026-09-28'].map((d) => past(`${d}T15:00:00Z`, 2));
  it('finds the usual gap', () => {
    expect(rhythmDays(weekly)).toBe(7);
    expect(rhythmLabel(7)).toBe('Weekly');
    expect(rhythmLabel(14)).toBe('Every 2 weeks');
    expect(rhythmDays(weekly.slice(0, 2))).toBeNull();
  });
  it('rating dots run oldest to newest', () => {
    const rows = [past('2026-10-26T15:00:00Z', 0), past('2026-10-19T15:00:00Z', null), past('2026-10-12T15:00:00Z', 2)];
    expect(ratingDots(rows)).toEqual(['happy', 'none', 'unhappy']);
  });
  it('preferred needs 2+ happy and no unhappy; avoid is unhappy and never happy', () => {
    const rows = [past('2026-10-26T15:00:00Z', 2), past('2026-10-19T15:00:00Z', 2), past('2026-10-12T15:00:00Z', 0, { id: 9, title: 'Drew Leblanc' })];
    const a = cleanerAffinity(rows);
    expect(a.preferred?.name).toBe('Quinn Clark');
    expect(a.avoid.map((c) => c.name)).toEqual(['Drew Leblanc']);
  });
});

describe('insights and summary', () => {
  const history = ['2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05'].map((d) => past(`${d}T15:00:00Z`, 2));
  it('between visits', () => {
    const next = booking({ id: 9, service_date: '2026-11-05T13:00:00Z', teams: [{ id: 7, title: 'Quinn Clark' }] });
    const i = insights(history, [next], NOW);
    expect(i.state).toBe('between');
    expect(i.spend).toBe(800);
    const s = summarySentence(i, { since: '2018-03-01', city: 'Kanata', now: NOW });
    expect(s.lead).toBe('Weekly since 2018 in Kanata, 4 cleans. Happy with the last 4 rated visits. Prefers Quinn Clark.');
    expect(s.emphasis).toMatch(/^All good\. Next visit is Thursday with Quinn\.$/);
  });
  it('lapsed and overdue', () => {
    const old = ['2026-09-12', '2026-08-29', '2026-08-15', '2026-08-01'].map((d) => past(`${d}T15:00:00Z`, 2));
    old[0] = past('2026-09-12T15:00:00Z', 0);
    const i = insights(old, [], NOW);
    expect(i.state).toBe('lapsed');
    expect(i.overdue).toBe(true);
    expect(i.unhappyRecently).toBe(true);
    expect(summarySentence(i, { now: NOW }).emphasis).toBe('Nothing booked, and no visit in 7 weeks.');
  });
  it('live', () => {
    const today = booking({ id: 5, service_date: '2026-11-02T18:00:00Z', teams: [{ id: 3, title: 'Riley Wright' }], time_tracking: [{ enroute_started_at: '2026-11-02T18:22:00Z' }] });
    const i = insights(history, [today], Date.parse('2026-11-02T18:50:00Z'));
    expect(i.state).toBe('live');
    expect(summarySentence(i, { now: Date.parse('2026-11-02T18:50:00Z') }).emphasis).toMatch(/^Riley is en route but hasn't checked in/);
  });
  it('new customer', () => {
    expect(insights([], [], NOW).state).toBe('new');
  });
});
