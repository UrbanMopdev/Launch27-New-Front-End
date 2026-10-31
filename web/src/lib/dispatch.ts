// Dispatch board logic: lays a day's bookings out on cleaner rows, finds double-bookings and
// visits outside a cleaner's hours, and ranks cleaners for a booking (free → working → nearest).

import { TIMEZONE } from '../format';

export interface DispatchBooking {
  // Projected visits of a recurring series (future dates) have no id yet, only this.
  id?: number;
  forecasted_from_booking?: { id: number; service_date: string } | null;
  service_date: string;
  arrival_window?: number | string;
  duration?: number; // minutes
  active?: boolean;
  user?: { id?: number; name?: string; email?: string };
  phone?: string;
  address?: { full_address?: string; street?: string; city?: string; latitude?: number | null; longitude?: number | null };
  location?: { id?: number; name?: string };
  services?: { id: number; name: string }[];
  frequency?: { name?: string };
  teams?: { id: number; title?: string; hours?: number; share?: number; bg_color?: string }[];
  time_tracking?: { team?: { id: number }; enroute_started_at?: string | null; checkin_at?: string | null; checkout_at?: string | null }[];
  staff_notes?: string | null;
  customer_notes?: string | null;
  summary?: { total?: number };
}

export interface DispatchTeam {
  id: number;
  title: string;
  phone?: string;
  bg_color?: string;
  latitude?: number | null;
  longitude?: number | null;
  share?: number;
  locations?: { id: number; name: string }[];
}

export interface AvailabilityRow {
  date: string | null;
  weekday: number;
  start_time: string | null;
  end_time: string | null;
  dayoff: boolean;
}

export type BlockStatus = 'scheduled' | 'enroute' | 'onsite' | 'done' | 'late' | 'unassigned';

export interface Block {
  booking: DispatchBooking;
  teamId: number | null;
  start: number; // minutes from local midnight
  end: number;
  status: BlockStatus;
  conflict: boolean; // overlaps another block in the same row
  outside: boolean; // outside the cleaner's hours (or their day off)
}

/** Minutes since local midnight (in TIMEZONE) for an ISO timestamp. */
export function localMinutes(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value);
  return h * 60 + m;
}

export const hhmmToMinutes = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + (m || 0);
};

export const fmtClock = (min: number) => {
  const h = Math.floor(min / 60) % 24;
  const m = Math.round(min % 60);
  const ampm = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${ampm}`;
};

/** A cleaner's working window on a date (date-specific row wins over the weekly one). */
export function workingWindow(rows: AvailabilityRow[] | undefined, date: string): { start: number; end: number } | 'off' | null {
  if (!rows) return null;
  const dow = new Date(`${date}T12:00:00`).getDay();
  const row = rows.find((r) => r.date && r.date.slice(0, 10) === date) || rows.find((r) => !r.date && r.weekday === dow);
  if (!row) return null;
  if (row.dayoff || !row.start_time || !row.end_time) return 'off';
  return { start: hhmmToMinutes(row.start_time), end: hhmmToMinutes(row.end_time) };
}

/** Length of one cleaner's part of a booking, in minutes. */
export function blockMinutes(b: DispatchBooking, teamId: number | null): number {
  const team = teamId !== null ? b.teams?.find((t) => t.id === teamId) : undefined;
  if (team?.hours && team.hours > 0) return team.hours * 60;
  const n = Math.max(1, b.teams?.length || 1);
  if (b.duration && b.duration > 0) return b.duration / n;
  return 120;
}

export function statusOf(b: DispatchBooking, teamId: number | null, now = Date.now()): BlockStatus {
  if (teamId === null) return 'unassigned';
  const tt = b.time_tracking?.find((t) => t.team?.id === teamId) || (b.teams?.length === 1 ? b.time_tracking?.[0] : undefined);
  if (tt?.checkout_at) return 'done';
  if (tt?.checkin_at) return 'onsite';
  if (tt?.enroute_started_at) return 'enroute';
  const windowEnd = new Date(b.service_date).getTime() + (Number(b.arrival_window) || 0) * 60_000;
  return now > windowEnd ? 'late' : 'scheduled';
}

/** True for a projected (not yet created) visit of a recurring series. */
export const isProjected = (b: DispatchBooking) => !b.id && !!b.forecasted_from_booking;

/** Stable key for any booking, including projected ones. */
export const bookingKey = (b: DispatchBooking) => (b.id ? String(b.id) : `p${b.forecasted_from_booking?.id}-${b.service_date}`);

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** Lay out bookings into blocks per cleaner row (key null = unassigned). */
export function buildBoard(bookings: DispatchBooking[], availability: Map<number, AvailabilityRow[]>, date: string, now = Date.now()) {
  const rows = new Map<number | null, Block[]>();
  for (const b of bookings) {
    if (b.active === false) continue;
    const start = localMinutes(b.service_date);
    const teamIds = b.teams?.length ? b.teams.map((t) => t.id) : [null];
    for (const teamId of teamIds) {
      const block: Block = { booking: b, teamId, start, end: start + blockMinutes(b, teamId), status: statusOf(b, teamId, now), conflict: false, outside: false };
      rows.set(teamId, [...(rows.get(teamId) || []), block]);
    }
  }
  for (const [teamId, blocks] of rows) {
    blocks.sort((a, b) => a.start - b.start);
    if (teamId === null) continue;
    const win = workingWindow(availability.get(teamId), date);
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        if (overlaps(blocks[i], blocks[j])) blocks[i].conflict = blocks[j].conflict = true;
      }
      if (win === 'off' || (win && (blocks[i].start < win.start || blocks[i].end > win.end))) blocks[i].outside = true;
    }
  }
  return rows;
}

/** Great-circle distance in km. */
export function distanceKm(a: { latitude?: number | null; longitude?: number | null }, b: { latitude?: number | null; longitude?: number | null }): number | null {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return null;
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface Candidate {
  team: DispatchTeam;
  fit: 'free' | 'busy' | 'outside' | 'off' | 'unknown';
  note: string;
  km: number | null;
  bookedMin: number;
}

/**
 * Rank cleaners for a booking: free and working at that time first, then nearest to the
 * home, then least busy that day. Cleaners already on the booking are excluded.
 */
export function rankCandidates(
  booking: DispatchBooking,
  teams: DispatchTeam[],
  board: Map<number | null, Block[]>,
  availability: Map<number, AvailabilityRow[]>,
  date: string,
): Candidate[] {
  const start = localMinutes(booking.service_date);
  const span = { start, end: start + blockMinutes(booking, null) };
  const already = new Set((booking.teams || []).map((t) => t.id));
  const order = { free: 0, outside: 1, unknown: 2, busy: 3, off: 4 } as const;
  return teams
    .filter((t) => !already.has(t.id))
    .filter((t) => !booking.location?.id || !t.locations?.length || t.locations.some((l) => l.id === booking.location!.id))
    .map((team) => {
      const blocks = (board.get(team.id) || []).filter((b) => bookingKey(b.booking) !== bookingKey(booking));
      const clash = blocks.find((b) => !isProjected(b.booking) && overlaps(b, span));
      const win = workingWindow(availability.get(team.id), date);
      const bookedMin = blocks.reduce((s, b) => s + (b.end - b.start), 0);
      let fit: Candidate['fit'];
      let note: string;
      if (win === 'off') {
        fit = 'off';
        note = 'Day off';
      } else if (clash) {
        fit = 'busy';
        note = `Busy ${fmtClock(clash.start)}–${fmtClock(clash.end)}`;
      } else if (win && (span.start < win.start || span.end > win.end)) {
        fit = 'outside';
        note = `Works ${fmtClock(win.start)}–${fmtClock(win.end)}`;
      } else if (!win) {
        fit = 'unknown';
        note = 'No hours set';
      } else {
        fit = 'free';
        note = blocks.length ? `Free · ${blocks.length} other job${blocks.length > 1 ? 's' : ''} today` : 'Free all day';
      }
      return { team, fit, note, km: distanceKm(team, booking.address || {}), bookedMin };
    })
    .sort((a, b) => order[a.fit] - order[b.fit] || (a.km ?? 999) - (b.km ?? 999) || a.bookedMin - b.bookedMin);
}
