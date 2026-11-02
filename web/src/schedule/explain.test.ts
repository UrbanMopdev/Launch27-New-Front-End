import { describe, expect, it } from 'vitest';
import { explain } from '../pages/Scheduling';
import type { Change } from './api';

const visit = { key: '1', id: 1, date: '2026-11-03', start: 780, duration: 210, time: '1pm', end: '4:30pm', customer_id: 5, customer: 'Skyler Smith', area: 'Kanata', freq: 'Biweekly', kind: 'bi', prepaid: false, weeks: 'BD', projected: false, cleaners: [{ id: 9, name: 'Sage Young' }], services: [] } as Change['visit'];
const base = (kind: Change['kind'], extra: Partial<Change> = {}): Change => ({ id: 1, kind, title: '', due: '2026-11-03', urgent: true, days_away: 1, detail: {}, created_at: '', visit, cleaner: { id: 9, name: 'Sage Young', status: 'Active', hours: '8am–1pm', working: true }, client: null, suggestions: [], ...extra });

describe('Changes to handle: plain headlines', () => {
  it('outside hours says whose hours and when', () => {
    const e = explain(base('outside_hours'));
    expect(e.headline).toBe("Skyler Smith's clean is outside Sage's working hours");
    expect(e.why).toBe('Sage Young works 8am–1pm that day, but this clean runs 1pm–4:30pm.');
  });
  it('a cleaner not working that weekday', () => {
    expect(explain(base('outside_hours', { cleaner: { id: 9, name: 'Sage Young', status: 'Active', hours: null, working: false } })).why).toBe("Sage Young doesn't work on Tuesdays.");
  });
  it('clash, unavailable, no cleaner, moved, cancelled', () => {
    expect(explain(base('double_booked', { detail: { with: ['Blake Brown'] } })).headline).toBe('Sage is booked for two cleans at the same time');
    expect(explain(base('double_booked', { detail: { with: ['Blake Brown'] } })).why).toBe('Skyler Smith (1pm–4:30pm) overlaps with Blake Brown.');
    expect(explain(base('cleaner_unavailable', { detail: { why: 'on hold' } })).why).toBe('Sage Young is on hold, so this clean needs someone else.');
    expect(explain(base('unassigned')).headline).toBe('No cleaner yet for Skyler Smith');
    expect(explain(base('moved', { detail: { from_label: 'Tue, Nov 3 at 9am', to_label: 'Thu, Nov 5 at 1pm' } })).why).toBe('From Tue, Nov 3 at 9am to Thu, Nov 5 at 1pm.');
    expect(explain(base('cancelled', { detail: { when_label: 'Tue, Nov 3 at 1pm', duration: 210 } })).why).toBe('Tue, Nov 3 at 1pm. Sage Young now has 3.5h free.');
  });
  it('usual cleaner free names the usual cleaner and their history', () => {
    const client = { id: 5, name: 'Skyler Smith', phone: null, recurring: true, main: { id: 3, name: 'Riley Wright', visits: 5, of: 6, available: true }, prefs: { female_only: false, prefers_female: false, prefers_male: false, consistent: false, prefers: [], avoid: [] }, notes: [] };
    const e = explain(base('different_cleaner', { client, detail: { booked: ['Sage Young'] } }));
    expect(e.headline).toBe("Skyler Smith's usual cleaner is free for this visit");
    expect(e.why).toBe("It's booked with Sage Young. Riley Wright did 5 of their last 6 visits and is free then.");
  });
});
