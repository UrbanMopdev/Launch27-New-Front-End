// Cleaner day routes: home → job 1 → job 2 → … → home, with approximate driving distance and
// time per leg, tight connections, long drives, closer-cleaner hints and check-in location checks.
//
// Distances are straight-line × ROAD_FACTOR (typical urban detour) and times assume AVG_KMH.
// They're estimates — good for comparing days and cleaners, not for mileage claims.

import { blockMinutes, distanceKm, localMinutes, type DispatchBooking, type DispatchTeam } from './dispatch';

export const ROAD_FACTOR = 1.4;
export const AVG_KMH = 40;
export const CHECKIN_TOLERANCE_KM = 0.3;

export type LatLng = { latitude?: number | null; longitude?: number | null };

export interface Leg {
  from: string;
  to: string;
  fromPoint: LatLng;
  toPoint: LatLng;
  km: number | null; // approximate road km
  minutes: number | null; // approximate drive time
}

export interface RouteStop {
  booking: DispatchBooking;
  start: number; // minutes since local midnight
  end: number;
  legIn: Leg;
  gapBefore: number | null; // minutes between previous job's end and this start
  tight: boolean; // gap shorter than the drive
  checkinOffKm: number | null; // how far from the address the cleaner checked in
}

export interface CleanerRoute {
  team: DispatchTeam;
  stops: RouteStop[];
  legHome: Leg | null; // last job → home
  km: number; // total approximate road km (known legs)
  minutes: number;
  unknownLegs: number; // legs without coordinates
  longestLeg: Leg | null;
}

export const roadKm = (a: LatLng, b: LatLng) => {
  const d = distanceKm(a, b);
  return d === null ? null : d * ROAD_FACTOR;
};
const driveMin = (km: number | null) => (km === null ? null : (km / AVG_KMH) * 60);
const leg = (from: string, fromPoint: LatLng, to: string, toPoint: LatLng): Leg => {
  const km = roadKm(fromPoint, toPoint);
  return { from, to, fromPoint, toPoint, km, minutes: driveMin(km) };
};
const shortName = (b: DispatchBooking) => b.user?.name || `#${b.id}`;

export function buildRoutes(bookings: DispatchBooking[], teams: DispatchTeam[]): CleanerRoute[] {
  const byTeam = new Map<number, DispatchBooking[]>();
  for (const b of bookings) {
    if (b.active === false) continue;
    for (const t of b.teams || []) byTeam.set(t.id, [...(byTeam.get(t.id) || []), b]);
  }
  const routes: CleanerRoute[] = [];
  for (const team of teams) {
    const jobs = (byTeam.get(team.id) || []).slice().sort((a, b) => Date.parse(a.service_date) - Date.parse(b.service_date));
    if (!jobs.length) continue;
    const home: LatLng = { latitude: team.latitude, longitude: team.longitude };
    let prevPoint: LatLng = home;
    let prevLabel = 'Home';
    let prevEnd: number | null = null;
    const stops: RouteStop[] = jobs.map((b) => {
      const start = localMinutes(b.service_date);
      const end = start + blockMinutes(b, team.id);
      const point: LatLng = b.address || {};
      const legIn = leg(prevLabel, prevPoint, shortName(b), point);
      const gapBefore = prevEnd === null ? null : Math.round(start - prevEnd);
      const tt = b.time_tracking?.find((t) => t.team?.id === team.id) as (NonNullable<DispatchBooking['time_tracking']>[number] & { checkin_latitude?: number | null; checkin_longitude?: number | null }) | undefined;
      const checkinOffKm = tt?.checkin_latitude != null ? distanceKm({ latitude: tt.checkin_latitude, longitude: tt.checkin_longitude }, point) : null;
      const stop: RouteStop = { booking: b, start, end, legIn, gapBefore, tight: gapBefore !== null && legIn.minutes !== null && gapBefore < legIn.minutes, checkinOffKm };
      prevPoint = point;
      prevLabel = shortName(b);
      prevEnd = end;
      return stop;
    });
    const legHome = leg(prevLabel, prevPoint, 'Home', home);
    const legs = [...stops.map((s) => s.legIn), legHome];
    const known = legs.filter((l) => l.km !== null);
    routes.push({
      team,
      stops,
      legHome,
      km: known.reduce((s, l) => s + l.km!, 0),
      minutes: known.reduce((s, l) => s + l.minutes!, 0),
      unknownLegs: legs.length - known.length,
      longestLeg: known.reduce<Leg | null>((m, l) => (!m || l.km! > m.km! ? l : m), null),
    });
  }
  return routes.sort((a, b) => b.km - a.km);
}

export interface CloserHint {
  booking: DispatchBooking;
  assigned: DispatchTeam;
  assignedKm: number;
  alternative: DispatchTeam;
  alternativeKm: number;
}

/**
 * First jobs of the day where another cleaner who is working that day lives much closer.
 * Only first jobs: later legs depend on where the cleaner's previous job was.
 */
export function closerCleanerHints(routes: CleanerRoute[], minSavingKm = 10): CloserHint[] {
  const working = routes.map((r) => r.team);
  const hints: CloserHint[] = [];
  for (const r of routes) {
    const first = r.stops[0];
    if (!first || first.legIn.km === null) continue;
    let best: { team: DispatchTeam; km: number } | null = null;
    for (const t of working) {
      if (t.id === r.team.id) continue;
      const km = roadKm(t, first.booking.address || {});
      if (km !== null && (!best || km < best.km)) best = { team: t, km };
    }
    if (best && first.legIn.km - best.km >= minSavingKm) hints.push({ booking: first.booking, assigned: r.team, assignedKm: first.legIn.km, alternative: best.team, alternativeKm: best.km });
  }
  return hints.sort((a, b) => b.assignedKm - b.alternativeKm - (a.assignedKm - a.alternativeKm));
}

export const fmtKm = (km: number | null) => (km === null ? '—' : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);
export const fmtMin = (m: number | null) => (m === null ? '—' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}`);
