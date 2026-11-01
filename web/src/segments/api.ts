// Client for customer segments (/api/segments on our own server).
import { ApiError, describeErrors } from '../api';

export type SegmentId = 'recurring' | 'risk' | 'repeat' | 'first' | 'lapsedRec' | 'lapsedOne';
export type TraitId = 'prepaid' | 'newplan' | 'converted' | 'vip' | 'cancelled';
export type Outcome = 'rebooked' | 'pause' | 'price' | 'quality' | 'cleaner' | 'moved' | 'no_answer' | 'other' | 'snoozed';

export interface SegmentSettings {
  risk_days: number;
  first_days: number;
  repeat_days: number;
  new_plan_days: number;
}

export interface SegmentSummary {
  segments: { id: SegmentId; label: string; group: 'active' | 'past'; count: number; revenue_12m: number; revenue_share: number }[];
  traits: { id: TraitId; label: string; count: number }[];
  total: number;
  no_recent: number | null;
  updated_at: string | null;
  running: boolean;
  last_error: string | null;
  next_run_at: string | null;
  settings: SegmentSettings;
}

export interface SegmentRow {
  customer_id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  segment: SegmentId;
  traits: TraitId[];
  since: string | null;
  plan: string | null;
  last_clean: string | null;
  next_clean: string | null;
  last_prepaid: string | null;
  spend_12m: number;
  cleans_12m: number;
  suggestion: string;
  days_left: number | null;
  days_since_last: number | null;
  last_outcome: Outcome | null;
  last_outcome_at: string | null;
  snoozed_until: string | null;
}

export interface SegmentChange {
  from_segment: SegmentId | 'new';
  to_segment: SegmentId;
  changed_on: string;
  estimated: boolean;
}

export interface CustomerSegment extends SegmentRow {
  history: SegmentChange[];
  outcomes: { outcome: Outcome; note: string | null; segment: SegmentId; snoozed_until: string | null; created_at: string; by: string | null }[];
}

export interface SegmentStats {
  customers: number;
  revenue_12m: number;
  not_contacted: number;
  lapsing_this_week: number | null;
  saved_this_month: number;
  top_reason: Outcome | null;
}

export type Period = '30d' | '90d' | '12m' | 'custom';
export interface Trends {
  period: Period;
  from: string;
  to: string;
  series: ({ day: string; estimated: boolean } & Record<SegmentId, number>)[];
  estimated_until: string | null;
  moves: { from_segment: SegmentId | 'new'; to_segment: SegmentId; n: number }[];
  flow: { start: number; new: number; converted: number; won_back: number; left: number; end: number };
  kpis: { recurring: number; recurring_change: number; joined: number; to_risk: number; saved: number; save_rate: number | null };
  first_timers: { total: number; lapsed: number; still: number; repeat: number; plan: number };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/segments${path}`, {
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

const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
  return s ? `?${s}` : '';
};

export const segmentsApi = {
  summary: () => call<SegmentSummary>('GET', '/summary'),
  customers: (p: { segment?: SegmentId | null; traits?: TraitId[]; q?: string; limit?: number; offset?: number }) =>
    call<{ total: number; rows: SegmentRow[] }>('GET', `/customers${qs({ segment: p.segment, traits: p.traits?.join(','), q: p.q, limit: p.limit, offset: p.offset })}`),
  customer: (id: number) => call<CustomerSegment>('GET', `/customer/${id}`),
  logOutcome: (id: number, body: { outcome: Outcome; note?: string; snooze_days?: number }) => call<void>('POST', `/customer/${id}/outcome`, body),
  stats: (segment: SegmentId) => call<SegmentStats>('GET', `/stats/${segment}`),
  trends: (p: { period: Period; from?: string; to?: string }) => call<Trends>('GET', `/trends${qs(p)}`),
  refresh: () => call<{ running: boolean }>('POST', '/refresh'),
  saveSettings: (s: Partial<SegmentSettings>) => call<SegmentSettings>('PUT', '/settings', s),
};
