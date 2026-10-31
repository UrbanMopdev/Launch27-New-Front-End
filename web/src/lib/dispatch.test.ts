import { describe, expect, it } from 'vitest';
import { blockMinutes, buildBoard, distanceKm, fmtClock, localMinutes, rankCandidates, statusOf, workingWindow, type AvailabilityRow, type DispatchBooking } from './dispatch';

// 2026-11-02 is a Monday; 13:00Z = 8:00am in Toronto/Ottawa (EST after Nov 1).
const DAY = '2026-11-02';
const weekly = (start: string, end: string): AvailabilityRow[] =>
  [0, 1, 2, 3, 4, 5, 6].map((d) => ({ date: null, weekday: d, start_time: d === 0 ? null : start, end_time: d === 0 ? null : end, dayoff: d === 0 }));

const booking = (id: number, utcTime: string, teams: DispatchBooking['teams'], extra: Partial<DispatchBooking> = {}): DispatchBooking => ({
  id,
  service_date: `${DAY}T${utcTime}:00Z`,
  arrival_window: 60,
  duration: 180,
  teams,
  address: { latitude: 45.42, longitude: -75.69 },
  ...extra,
});

describe('dispatch', () => {
  it('converts to local clock minutes', () => {
    expect(localMinutes(`${DAY}T13:00:00Z`)).toBe(8 * 60);
    expect(fmtClock(13 * 60 + 30)).toBe('1:30pm');
    expect(fmtClock(8 * 60)).toBe('8am');
  });

  it('reads working windows, with date-specific rows winning', () => {
    const rows = weekly('09:00', '17:00');
    expect(workingWindow(rows, DAY)).toEqual({ start: 540, end: 1020 });
    expect(workingWindow(rows, '2026-11-01')).toBe('off'); // Sunday
    expect(workingWindow([...rows, { date: DAY, weekday: 1, start_time: null, end_time: null, dayoff: true }], DAY)).toBe('off');
    expect(workingWindow(undefined, DAY)).toBeNull();
  });

  it('uses per-cleaner hours, else splits the duration', () => {
    expect(blockMinutes(booking(1, '13:00', [{ id: 5, hours: 2 }]), 5)).toBe(120);
    expect(blockMinutes(booking(1, '13:00', [{ id: 5 }, { id: 6 }]), 5)).toBe(90);
    expect(blockMinutes(booking(1, '13:00', [], { duration: 0 }), null)).toBe(120);
  });

  it('derives status from time tracking', () => {
    const b = booking(1, '13:00', [{ id: 5 }], { time_tracking: [{ team: { id: 5 }, checkin_at: `${DAY}T13:10:00Z` }] });
    expect(statusOf(b, 5)).toBe('onsite');
    expect(statusOf(booking(2, '13:00', [{ id: 5 }]), 5, Date.parse(`${DAY}T15:00:00Z`))).toBe('late');
    expect(statusOf(booking(2, '13:00', [{ id: 5 }]), 5, Date.parse(`${DAY}T12:00:00Z`))).toBe('scheduled');
    expect(statusOf(booking(3, '13:00', []), null)).toBe('unassigned');
  });

  it('flags double-bookings and visits outside hours', () => {
    const avail = new Map([[5, weekly('09:00', '17:00')]]);
    const board = buildBoard([booking(1, '13:00', [{ id: 5, hours: 3 }]), booking(2, '15:00', [{ id: 5, hours: 2 }]), booking(3, '20:00', [{ id: 5, hours: 2 }])], avail, DAY);
    const row = board.get(5)!;
    expect(row.map((b) => b.conflict)).toEqual([true, true, false]); // 8–11am overlaps 10am–12pm
    expect(row.map((b) => b.outside)).toEqual([true, false, false]); // 8am start is before 9am
  });

  it('ranks free and nearby cleaners first', () => {
    const avail = new Map([
      [1, weekly('08:00', '18:00')],
      [2, weekly('08:00', '18:00')],
      [3, weekly('08:00', '18:00')],
    ]);
    const target = booking(10, '13:00', []);
    const board = buildBoard([target, booking(11, '13:30', [{ id: 3, hours: 2 }])], avail, DAY);
    const teams = [
      { id: 1, title: 'Far', latitude: 45.3, longitude: -75.9 },
      { id: 2, title: 'Near', latitude: 45.421, longitude: -75.691 },
      { id: 3, title: 'Busy', latitude: 45.42, longitude: -75.69 },
    ];
    const ranked = rankCandidates(target, teams, board, avail, DAY);
    expect(ranked.map((c) => c.team.title)).toEqual(['Near', 'Far', 'Busy']);
    expect(ranked[2].fit).toBe('busy');
  });

  it('computes distance', () => {
    expect(distanceKm({ latitude: 45.4215, longitude: -75.6972 }, { latitude: 45.5017, longitude: -73.5673 })).toBeGreaterThan(160);
    expect(distanceKm({ latitude: null, longitude: null }, { latitude: 1, longitude: 1 })).toBeNull();
  });
});
