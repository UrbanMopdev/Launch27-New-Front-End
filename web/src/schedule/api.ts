// Client for the scheduling planner (/api/schedule on our own server).
import { ApiError, describeErrors } from '../api';

export type Tone = 'good' | 'neutral' | 'warn';
export interface Reason { text: string; tone: Tone }
export type CleanerStatus = 'active' | 'new' | 'not_ready' | 'off_schedule' | 'on_hold' | 'no_code';

export interface Cleaner {
  id: number;
  name: string;
  status: CleanerStatus;
  status_label: string;
  assignable: boolean;
  is_new: boolean;
  gender: 'F' | 'M' | null;
  hours_type: 'FT' | 'PT' | null;
  color: string;
  area: string;
  phone: string | null;
  weekly_hours: number;
  tags: string[];
  rules: { transit: boolean; maxTravelMin: number | null; lastMinute: boolean; noShort: boolean; confirmFirst: boolean };
}

export interface Visit {
  key: string;
  id: number | null;
  date: string;
  start: number;
  duration: number;
  time: string;
  customer_id: number | null;
  customer: string;
  area: string | null;
  freq: string;
  kind: 'weekly' | 'bi' | 'monthly' | 'tri' | 'one';
  prepaid: boolean;
  weeks: string;
  projected: boolean;
  cleaners: { id: number; name: string }[];
}

export interface Candidate {
  cleaner_id: number;
  name: string;
  color: string;
  status: CleanerStatus;
  score: number;
  fits: number;
  total: number;
  travel: number | null;
  reasons: Reason[];
}

export interface Status { taken_at: string | null; full_at: string | null; running: boolean; last_error: string | null; refresh_minutes: number; full_minutes: number }

export interface Overview {
  taken_at: string;
  today: string;
  weeks: { from: string; to: string; cycle: string }[];
  rows: (Cleaner & { weeks: { booked: number; capacity: number; days_off: number }[] })[];
  unassigned: number[];
  areas: string[];
  counts: { cleaners: number; assignable: number; by_status: Record<CleanerStatus, number>; unassigned_visits: number; future_visits: number; open_changes: number };
}

export interface PlanCell { date: string; past: boolean; off: boolean; unavailable: boolean; hours: string | null; visits: Visit[]; gaps: { start: number; end: number; label: string; hours: number }[] }
export interface Plan {
  cleaner: Cleaner;
  days: string[];
  weeks: { cycle: string; from: string; to: string; booked: number; capacity: number; cells: PlanCell[] }[];
  avg_booked: number;
  home_clients: number;
  clients: number;
  hint: string;
}

export interface GapOptions {
  cleaner: Cleaner;
  date: string;
  gap: { start: number; end: number; label: string };
  options: { type: 'unassigned' | 'move'; visit: Visit; title: string; detail: string; distance_km?: number | null; action: 'assign' | 'contact'; exact: boolean }[];
}

export interface Series {
  key: string;
  customer_id: number;
  customer: string;
  freq: string;
  kind: Visit['kind'];
  prepaid: boolean;
  when: string;
  duration: number;
  area: string | null;
  first_date: string;
  visits: Visit[];
  projected: number;
  why: string | null;
  candidates: Candidate[];
}

export interface Continuity {
  clients: number;
  always: number;
  three_plus: number;
  visit_share: number | null;
  upcoming_count: number;
  upcoming: { visit: Visit; main: { id: number; name: string }; history: number; main_free: boolean; why: string }[];
  without_main: number;
}

export type ChangeKind = 'moved' | 'cancelled' | 'cleaner_changed' | 'availability' | 'unassigned' | 'outside_hours' | 'double_booked' | 'different_cleaner' | 'cleaner_unavailable';
export interface ClientInfo {
  id: number;
  name: string;
  phone: string | null;
  recurring: boolean;
  main: { id: number; name: string; visits: number; of: number; available: boolean } | null;
  prefs: { female_only: boolean; prefers_female: boolean; prefers_male: boolean; consistent: boolean; prefers: string[]; avoid: string[] };
  notes: string[];
}
export interface Change {
  id: number;
  kind: ChangeKind;
  title: string;
  due: string | null;
  urgent: boolean;
  days_away: number | null;
  detail: Record<string, unknown> & { why?: string; hours?: string; with?: string[]; from_label?: string; to_label?: string; when_label?: string; duration?: number; from_names?: string[]; to_names?: string[]; main?: string; booked?: string[]; affected_visits?: Visit[] };
  created_at: string;
  visit: (Visit & { end: string; services: string[] }) | null;
  cleaner: { id: number; name: string; status: string; hours: string | null; working: boolean } | null;
  client: ClientInfo | null;
  suggestions: Candidate[];
  series: { count: number; when: string; first: string; last: string; visit_keys: string[]; projected: number } | null;
}

export interface Slot {
  date: string;
  day: string;
  start: number;
  time: string;
  end: string;
  cycle: string;
  weeks: string;
  repeats: number;
  cleaner: { id: number; name: string; color: string; is_new: boolean };
  score: number;
  reasons: Reason[];
  travel: number | null;
}
export interface SlotQuery { customer_id?: number; duration: number; kind: Visit['kind']; from?: string; days?: number; weekdays?: number[]; earliest?: number; latest?: number }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/schedule${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const scheduleApi = {
  status: () => call<Status>('GET', '/status'),
  overview: () => call<Overview>('GET', '/overview'),
  plan: (id: number) => call<Plan>('GET', `/plan/${id}`),
  gap: (cleaner: number, date: string, start: number, end: number) => call<GapOptions>('GET', `/gap?cleaner=${cleaner}&date=${date}&start=${start}&end=${end}`),
  unassigned: () => call<{ total_series: number; total_visits: number; series: Series[] }>('GET', '/unassigned'),
  continuity: () => call<Continuity>('GET', '/continuity'),
  changes: () => call<{ items: Change[]; today: string }>('GET', '/changes'),
  resolve: (id: number, resolution: 'fixed' | 'dismissed') => call<void>('POST', `/changes/${id}/resolve`, { resolution }),
  findSlots: (q: SlotQuery) => call<{ place_known: boolean; frequency: string; duration: number; customer: { id: number; name: string; main: string | null } | null; slots: Slot[] }>('POST', '/find-slots', q),
  assign: (visit_keys: string[], cleaner_id: number) => call<{ assigned: number; projected: number; cleaner: string; confirm_first: boolean }>('POST', '/assign', { visit_keys, cleaner_id }),
  unavailable: (cleaner_id: number, day: string, unavailable = true) => call<{ cleaner: string; day: string; unavailable: boolean; affected: number }>('PUT', '/unavailable', { cleaner_id, day, unavailable }),
  refresh: () => call<{ running: boolean }>('POST', '/refresh'),
};
