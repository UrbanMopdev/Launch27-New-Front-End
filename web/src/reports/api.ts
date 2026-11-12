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

export interface CleanerRow {
  id: number;
  name: string;
  visits: number;
  on_time: number | null;
  late_avg: number | null;
  ran_long: number | null;
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
  flags: Flag[];
}

export interface CleanersReport {
  taken_at: string;
  period: Period;
  admin: boolean;
  team: { cleaners: number; median_visits: number | null; max_visits: number; on_time: number | null; check_ins: number; happy: number | null; rated_share: number | null; revenue: number; earned?: number; flagged: number };
  rows: CleanerRow[];
}

export interface CleanerReport {
  taken_at: string;
  period: Period;
  admin: boolean;
  cleaner: { id: number; name: string; status: string; status_label: string; area: string | null; color: string; tags: string[]; hours_type: string | null; phone: string | null; weekly_hours: number | null; first_seen: string | null };
  stats: Omit<CleanerRow, 'status' | 'status_label' | 'assignable' | 'area' | 'color' | 'is_new' | 'hours_type' | 'flags'> & { booked_next4: number | null; capacity_next4: number | null; per_hour?: number | null };
  flags: Flag[];
  series: { week: string; visits: number; on_time: number | null; happy: number | null }[];
  clients: { customer_id: number; customer: string; rhythm: string; since: string | null; cleans: number; last_rating: { r: number; comment: string | null; date: string } | null }[];
  lost: { customer: string; stopped: boolean; to: string | null }[];
  ratings: { date: string; customer: string; r: number; comment: string | null }[];
  last40: { date: string; late: number; long: boolean; enroute: boolean; customer: string }[];
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

async function call<T>(method: string, path: string): Promise<T> {
  const res = await fetch(`/api/reports${path}`, { method, credentials: 'same-origin' });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.json();
}

export const reportsApi = {
  status: () => call<ReportStatus>('GET', '/status'),
  scheduling: (period: Period, locations?: number[] | null) => call<SchedulingReport>('GET', `/scheduling?period=${period}${locations ? `&locations=${locations.join(',')}` : ''}`),
  cleaners: (period: Period, locations?: number[] | null) => call<CleanersReport>('GET', `/cleaners?period=${period}${locations ? `&locations=${locations.join(',')}` : ''}`),
  cleaner: (id: number, period: Period) => call<CleanerReport>('GET', `/cleaners/${id}?period=${period}`),
  refresh: () => call<{ running: boolean }>('POST', '/refresh'),
  utilization: (from: string | null, to: string | null, locations?: number[] | null) => call<UtilizationReport>('GET', `/utilization?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(locations ? { locations: locations.join(',') } : {}) })}`),
};

export const pct = (x: number | null | undefined, digits = 0) => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`);
export const money = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }));
