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

export type HeadroomStatus = 'red' | 'amber' | 'green' | null;
export interface HeadroomFigures {
  closed_h: number; available_h: number; assigned_h: number; unassigned_h: number; unassigned_visits: number;
  not_taking_h: number; not_taking_visits: number; travel_h: number; fragments_h: number;
  raw_h: number; raw_pct: number | null; adjusted_h: number; adjusted_pct: number | null;
  raw_status: HeadroomStatus; status: HeadroomStatus;
}
export interface HeadroomReport {
  taken_at: string | null; today: string; weeks: number; from: string; to: string;
  config: { travel_model: 'route'; travel_return_home: boolean; travel_fallback_min: number; avg_leg_min: number; fragment_h: number; red_at: number; amber_at: number; operating_days: number[]; windows: number[] };
  totals: HeadroomFigures;
  ratio: { cleaners: number; customers: number; customers_recurring: number; per_cleaner: number | null; per_cleaner_recurring: number | null };
  areas: (HeadroomFigures & { area: string; cleaners: number; customers: number; customers_recurring: number; customers_per_cleaner: number | null })[];
  cleaners: { cleaner_id: number; name: string; area: string; status_label: string | null; available_h: number; assigned_h: number; headroom_h: number; utilization: number | null; if_left: number | null; if_left_raw: number | null; area_negative: boolean }[];
  trend: { week: string; total: number | null; raw_total: number | null; areas: Record<string, number | null> }[];
  reconcile: null | {
    capacity: { existing: number; sundays: number; closed: number; other_brand: number; floor: number; result: number; tolerance: number; ties: boolean };
    booked: { existing: number; sundays: number; other_brand: number; result: number; ties: boolean };
    unassigned: { existing: number; other_brand: number; sundays: number; later: number; result: number; ties: boolean };
    window_weeks: number;
  };
  travel_reference: null | {
    measured: { median_min: number | null; average_min: number | null; visits: number; share_tapped: number | null; from: string; to: string };
    estimated: { average_min: number | null; legs: number };
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
  headroom: (weeks: number, locations?: number[] | null) => call<HeadroomReport>('GET', `/headroom?weeks=${weeks}${locations ? `&locations=${locations.join(',')}` : ''}`),
};

export const pct = (x: number | null | undefined, digits = 0) => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`);
export const money = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }));
