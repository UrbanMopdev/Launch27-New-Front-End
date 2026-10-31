import { describe, expect, it } from 'vitest';
import { buildRoutes, closerCleanerHints, fmtMin, roadKm, ROAD_FACTOR } from './routes';
import type { DispatchBooking, DispatchTeam } from './dispatch';

// 2026-11-02 (EST): 13:00Z = 8am, 16:00Z = 11am.
const at = (lat: number, lng: number) => ({ latitude: lat, longitude: lng });
const booking = (id: number, utc: string, teamId: number, lat: number, lng: number, hours = 2, extra: Partial<DispatchBooking> = {}): DispatchBooking => ({
  id,
  service_date: `2026-11-02T${utc}:00Z`,
  teams: [{ id: teamId, hours }],
  address: at(lat, lng),
  user: { name: `Customer ${id}` },
  ...extra,
});

describe('routes', () => {
  it('chains home → jobs → home with road-factor distances', () => {
    const team: DispatchTeam = { id: 1, title: 'A', ...at(45.4, -75.7) };
    const routes = buildRoutes([booking(11, '16:00', 1, 45.45, -75.7), booking(10, '13:00', 1, 45.42, -75.7)], [team]);
    const r = routes[0];
    expect(r.stops.map((s) => s.booking.id)).toEqual([10, 11]); // sorted by time
    expect(r.stops[0].legIn.from).toBe('Home');
    expect(r.stops[1].legIn.from).toBe('Customer 10');
    expect(r.legHome!.to).toBe('Home');
    const straight = roadKm(at(45.4, -75.7), at(45.42, -75.7))! / ROAD_FACTOR;
    expect(straight).toBeCloseTo(2.22, 1);
    expect(r.km).toBeCloseTo((2.22 + 3.34 + 5.56) * ROAD_FACTOR, 0);
  });

  it('flags a connection that is shorter than the drive', () => {
    const team: DispatchTeam = { id: 1, title: 'A', ...at(45.4, -75.7) };
    // 8–11am, then 11:05am job ~30 km away
    const r = buildRoutes([booking(1, '13:00', 1, 45.4, -75.7, 3), booking(2, '16:05', 1, 45.62, -75.5)], [team])[0];
    expect(r.stops[1].gapBefore).toBe(5);
    expect(r.stops[1].tight).toBe(true);
  });

  it('measures check-in distance from the address', () => {
    const team: DispatchTeam = { id: 1, title: 'A', ...at(45.4, -75.7) };
    const b = booking(1, '13:00', 1, 45.42, -75.7, 2, { time_tracking: [{ team: { id: 1 }, checkin_at: 'x', checkin_latitude: 45.43, checkin_longitude: -75.7 } as never] });
    expect(buildRoutes([b], [team])[0].stops[0].checkinOffKm).toBeCloseTo(1.11, 1);
  });

  it('suggests a much closer cleaner for first jobs', () => {
    const far: DispatchTeam = { id: 1, title: 'Far', ...at(45.2, -75.9) };
    const near: DispatchTeam = { id: 2, title: 'Near', ...at(45.421, -75.701) };
    const routes = buildRoutes([booking(1, '13:00', 1, 45.42, -75.7), booking(2, '13:00', 2, 45.3, -75.8)], [far, near]);
    const hints = closerCleanerHints(routes);
    expect(hints[0].assigned.title).toBe('Far');
    expect(hints[0].alternative.title).toBe('Near');
  });

  it('handles missing coordinates', () => {
    const team: DispatchTeam = { id: 1, title: 'A', latitude: null, longitude: null };
    const r = buildRoutes([booking(1, '13:00', 1, 45.42, -75.7)], [team])[0];
    expect(r.unknownLegs).toBe(2);
    expect(r.km).toBe(0);
  });

  it('formats minutes', () => {
    expect(fmtMin(45)).toBe('45 min');
    expect(fmtMin(95)).toBe('1h 35');
  });
});
