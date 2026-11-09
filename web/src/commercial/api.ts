// Client for /api/commercial: partner organizations and hospital programs (read-only).
import { ApiError, describeErrors } from '../api';
import type { Period } from '../reports/api';

export interface OrgRow {
  key: string; name: string; kind: 'homemaking' | 'program' | 'after' | 'company' | 'account'; kind_label: string;
  clients: number; visits: number; revenue: number; prev_revenue: number; trend: number | null; rhythm: string;
  same_cleaner: number | null; share: number; next: string | null; upcoming: number; unassigned_28d: number;
}
export interface Organizations { today: string; period: Period; from: string; totals: { organizations: number; clients: number; visits: number; revenue: number; partner_share: number; unassigned_28d: number }; rows: OrgRow[] }
export interface OrgClient { id: number; name: string; addr: string | null; visits: number; revenue: number; rhythm: string; cleaner: string | null; last: string | null; next: { date: string; time: number; cleaner: string | null } | null }
export interface Organization {
  today: string; period: Period; key: string; name: string; kind: OrgRow['kind']; kind_label: string; program: string | null;
  stats: { visits: number; revenue: number; clients: number; booked_ahead: number; avg: number | null; unassigned_28d: number };
  weeks: { week: string; visits: number; revenue: number }[]; clients: OrgClient[];
}
export interface PlanFlag { visit: number; gap: number; planned: number; past: boolean }
export interface Patient {
  client: number; name: string; addr: string | null; first: string; last_visit: string | null; visits: number; done: number; booked: number;
  state: 'active' | 'finished' | 'ended_early'; stage: 'weekly' | 'biweekly' | 'monthly'; next_planned: string | null; next_label: string | null;
  flags: PlanFlag[]; extra: number; unbooked: boolean; next_booked: { date: string; time: number; cleaner: string | null } | null; cleaner: string | null;
}
export interface Program {
  code: string; name: string; org: string | null; expected_per_month: number | null; active: number;
  stages: { weekly: number; biweekly: number; monthly: number }; off_plan: number; unbooked: number; completed_share: number | null; typical_visits: number | null;
  new_by_month: { month: string; patients: number }[]; patients: Patient[];
}
export interface Programs { today: string; plan: number[]; programs: Program[] }

async function call<T>(path: string): Promise<T> {
  const res = await fetch(`/api/commercial${path}`, { credentials: 'same-origin' });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.json();
}
const q = (period: Period, locations: number[] | null) => `?period=${period}${locations?.length ? `&locations=${locations.join(',')}` : ''}`;

export const commercialApi = {
  organizations: (period: Period, locations: number[] | null) => call<Organizations>(`/organizations${q(period, locations)}`),
  organization: (key: string, period: Period, locations: number[] | null) => call<Organization>(`/organizations/${encodeURIComponent(key)}${q(period, locations)}`),
  programs: () => call<Programs>('/programs'),
};
