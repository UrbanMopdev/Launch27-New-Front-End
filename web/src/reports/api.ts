// Client for scheduling insights and cleaner reports (/api/reports on our own server).
import { ApiError, describeErrors } from '../api';

export type Period = '4w' | '13w' | '12m';
export interface Flag { kind: string; label: string; detail: string }

export interface SchedulingReport {
  taken_at: string;
  period: Period;
  from: string;
  to: string;
  kpis: {
    same_cleaner: number | null; same_cleaner_visits: number;
    on_time: number | null; late_avg: number | null; check_ins: number;
    ran_long: number | null; hours_filled: number | null; unassigned_visits: number | null;
    km_per_visit: number | null; enroute: number | null; outside_area: number | null;
  };
  same_cleaner_series: { week: string; share: number | null; visits: number }[];
  areas: { area: string; filled: number | null; booked: number; capacity: number }[];
  lopsided: { cleaner_id: number; name: string; ac: number; bd: number }[];
  longest_drives: { cleaner: string; cleaner_id: number; date: string; km: number; area_out: boolean; customer: string }[];
  driving: { cleaner_id: number; name: string; area: string | null; km_per_visit: number | null; enroute: number | null; outside_area: number | null; visits: number }[];
  planner: { raised: number; handled: number; handled_share: number | null; median_hours: number | null; recommended_share: number | null; expired: number; open: number };
}

export type Grade = 'ready' | 'watch' | 'not_yet' | 'neutral';
export type Verdict = 'ready' | 'watch' | 'not_yet' | 'thin' | 'ceiling' | 'ladder';
export interface RowReliability { issues: number; no_shows: number | null; last_minute: number | null; short_notice: number | null; missing_checks: number; partial: boolean; covers_from: string | null; uncoded: number | null }
export interface Incident { date: string; visit_date: string | null; customer: string | null; kind: string; label: string; reason: string | null; lead_hours: number | null; counted: boolean; note: string | null; id: number | null }
export interface Reliability extends RowReliability {
  known: boolean; with_notice: number | null; sick_days: number | null; late: number; pattern: string | null;
  incidents: Incident[]; weeks: { week: string; drops: number | null; missing: number }[];
}
export interface Factor { key: string; label: string; grade: Grade; value: string; need: string | null; link: string | null; uses?: 'happy' | 'stars'; other?: string | null }
export interface RaiseReview {
  verdict: Verdict; label: string; underlying: 'ready' | 'watch' | 'not_yet'; thin: boolean; thin_reason: string | null; gates: string[]; ready_count: number; thin_ratings: boolean;
  factors: Factor[]; to_ready: string[]; re_review: string | null; ladder: { role: string; next: string | null } | null;
  from: string; to: string; rate: { current: number; since: string; previous: number | null; changed_on: string | null; first_seen: string } | null; margin: number | null; summary: string;
}
export interface GoogleReview { id: number; date: string; reviewer: string; link: string | null; bonus_paid: boolean }
export const DROP_REASONS: [string, string, boolean][] = [
  ['cleaner_sick', 'Cleaner – sick', true],
  ['cleaner_personal', 'Cleaner – personal', true],
  ['cleaner_no_show', 'Cleaner – no-show', true],
  ['client_cancelled', 'Client cancelled', false],
  ['office_reschedule', 'Office reschedule', false],
  ['weather', 'Weather/emergency', false],
];

export interface CleanerRow {
  id: number;
  name: string;
  visits: number;
  on_time: number | null;
  late_avg: number | null;
  ran_long: number | null;
  finished_early: number | null;
  early_n: number;
  residential: number;
  missing_checks: number;
  margin?: number | null;
  enroute: number | null;
  km_per_visit: number | null;
  rated: number;
  happy: number | null;
  unhappy: number;
  keeps: number | null;
  clients_started: number;
  revenue: number;
  earned?: number | null;
  onsite_hours: number;
  booked_hours: number;
  status: string;
  status_label: string;
  assignable: boolean;
  area: string | null;
  color: string;
  is_new: boolean;
  hours_type: string | null;
  hours_per_week: number | null;
  hours_filled: number | null;
  stars: number | null;
  ratings_count: number | null;
  reliability: RowReliability;
  google_reviews: number;
  flags: Flag[];
}

export interface CleanersReport {
  taken_at: string;
  period: Period;
  admin: boolean;
  change_log_start: string;
  team: { cleaners: number; median_visits: number | null; max_visits: number; on_time: number | null; check_ins: number; happy: number | null; rated_share: number | null; revenue: number; earned?: number; flagged: number; runs_long_median: number | null };
  rows: CleanerRow[];
}

export interface CleanerReport {
  taken_at: string;
  period: Period;
  admin: boolean;
  change_log_start: string;
  cleaner: { id: number; name: string; status: string; status_label: string; area: string | null; color: string; tags: string[]; hours_type: string | null; phone: string | null; weekly_hours: number | null; first_seen: string | null; start_date: string | null; start_known: boolean; stars: number | null; ratings_count: number | null; restrictive: { tag: string; kind: string }[] };
  stats: Omit<CleanerRow, 'status' | 'status_label' | 'assignable' | 'area' | 'color' | 'is_new' | 'hours_type' | 'flags' | 'stars' | 'ratings_count' | 'reliability' | 'google_reviews'> & { booked_next4: number | null; capacity_next4: number | null; per_hour?: number | null };
  team: { runs_long_median: number | null };
  reliability: Reliability;
  finished_early: { date: string; customer: string; short_min: number; visit_id: number }[];
  complaints: { id: number; subject: string | null; date: string; outcome: string | null; status: string | null; booking_id: number | null }[];
  google_reviews: GoogleReview[];
  raise?: RaiseReview;
  flags: Flag[];
  series: { week: string; visits: number; on_time: number | null; happy: number | null }[];
  clients: { customer_id: number; customer: string; rhythm: string; since: string | null; cleans: number; last_rating: { r: number; comment: string | null; date: string } | null }[];
  lost: { customer: string; stopped: boolean; to: string | null }[];
  ratings: { date: string; customer: string; r: number; comment: string | null }[];
  last40: { date: string; late: number; long: boolean; early: boolean; enroute: boolean; customer: string }[];
}

export interface UtilFigures {
  closed_h: number; available_h: number; assigned_h: number; unassigned_h: number; unassigned_visits: number;
  not_taking_h: number; not_taking_visits: number; travel_h: number; spoken_h: number; left_h: number;
  utilization: number | null; room_bookings: number; typical_booking_h: number;
}
export interface UtilizationReport {
  taken_at: string | null; today: string; from: string; to: string; max_to: string; avg_leg_min: number;
  totals: UtilFigures & { cleaners: number; customers: number; customers_recurring: number };
  areas: (UtilFigures & { area: string; cleaners: number; customers: number; customers_recurring: number })[];
  cleaners: { cleaner_id: number; name: string; area: string; status_label: string | null; visits: number; available_h: number; assigned_h: number; travel_h: number; travel_per_visit_min: number | null; left_h: number; utilization: number | null; if_left: number | null; area_short: boolean }[];
  by_day: (UtilFigures & { date: string; areas: Record<string, UtilFigures> })[];
  trend: { week: string; total: number | null; areas: Record<string, number | null> }[];
  reconcile: null | {
    capacity: { existing: number; sundays: number; closed: number; other_brand: number; floor: number; result: number; ties: boolean };
    booked: { existing: number; sundays: number; other_brand: number; result: number; ties: boolean };
    unassigned: { existing: number; other_brand: number; sundays: number; outside: number; result: number; ties: boolean };
    hours_from: string; hours_to: string;
  };
}

export interface ReportStatus { taken_at: string | null; running: boolean; last_error: string | null; covers_from: string | null }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/reports${path}`, { method, credentials: 'same-origin', ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const reportsApi = {
  status: () => call<ReportStatus>('GET', '/status'),
  scheduling: (period: Period, locations?: number[] | null) => call<SchedulingReport>('GET', `/scheduling?period=${period}${locations ? `&locations=${locations.join(',')}` : ''}`),
  cleaners: (period: Period, locations?: number[] | null) => call<CleanersReport>('GET', `/cleaners?period=${period}${locations ? `&locations=${locations.join(',')}` : ''}`),
  cleaner: (id: number, period: Period) => call<CleanerReport>('GET', `/cleaners/${id}?period=${period}`),
  refresh: () => call<{ running: boolean }>('POST', '/refresh'),
  recordDrop: (d: { cleaner_id: number; visit_key: string; booking_id?: number | null; customer?: string | null; visit_at: string; reason: string }) => call<{ id: number }>('POST', '/drops', d),
  codeChange: (changeId: number, reason: string) => call<{ coded: number }>('POST', `/changes/${changeId}/reason`, { reason }),
  addReview: (cleanerId: number, r: { review_date: string; reviewer: string; link?: string | null; bonus_paid?: boolean }) => call<{ id: number }>('POST', `/cleaners/${cleanerId}/reviews`, r),
  updateReview: (id: number, r: { bonus_paid: boolean }) => call<void>('PATCH', `/reviews/${id}`, r),
  deleteReview: (id: number) => call<void>('DELETE', `/reviews/${id}`),
  utilization: (from: string | null, to: string | null, locations?: number[] | null) => call<UtilizationReport>('GET', `/utilization?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(locations ? { locations: locations.join(',') } : {}) })}`),
};

export const pct = (x: number | null | undefined, digits = 0) => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`);
export const money = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }));
