// Client for the complaints tracker (/api/tracker) and the Cleaner Adjustment form (/api/adjustments).
import { ApiError, describeErrors } from '../api';

// cleaner, customer and user are names linked to a record; `id` is the column holding its id.
export type FieldType = 'text' | 'long' | 'date' | 'number' | 'select' | 'cleaner' | 'customer' | 'user';
export interface TrackerField { key: string; label: string; type: FieldType; options?: string[]; panel: string; id?: string }
export interface TrackerMeta {
  fields: TrackerField[];
  panels: { key: string; label: string }[];
  statuses: string[];
  views: { slug: string; name: string; kind: 'complaints' | 'conversations' }[];
  columns: { key: string; label: string }[];
  rating_days: number;
  users: { id: number; name: string | null; email: string }[];
  kustomer: 'connected' | 'not connected';
  close_fields: string[];
  playbook: boolean;
}
export type ComplaintState = 'open' | 'snoozed' | 'done';
// One complaint. The picklist and text fields are keyed by TrackerField.key.
export interface ComplaintRecord {
  id: number;
  source: 'ops' | 'kustomer' | 'sample';
  title: string;
  state: ComplaintState;
  snooze_until: string | null;
  conversation_id: number | null;
  contact_id: number | null;
  l27_customer_id: number | null;
  l27_booking_id: number | null;
  assigned_user_id: number | null;
  assigned_user: string | null;
  created_at: string;
  updated_at: string;
  comment_count: number;
  rating_days_left: number | null;
  contact_name?: string | null;
  created_by_name?: string | null;
  conversation_subject?: string | null;
  conversation_channel?: string | null;
  [field: string]: string | number | null | undefined;
}
export interface ComplaintComment { id: number; body: string; created_at: string; author_id: number | null; author: string | null }
export interface ComplaintDetail { record: ComplaintRecord; comments: ComplaintComment[]; existing?: boolean }
export interface ComplaintList { view: { slug: string; name: string }; sort: string; dir: 'asc' | 'desc'; rows: ComplaintRecord[] }
export type ComplaintPatch = Record<string, string | number | null>;
export interface PositiveFeedback {
  conversation_id: number;
  flagged_at: string;
  flagged_by: string | null;
  subject: string | null;
  channel: string;
  last_preview: string | null;
  last_message_at: string | null;
  cleaner_name: string | null;
  contact_id: number | null;
  contact_name: string | null;
  owner: string | null;
}
export interface LoadStatus { connected: boolean; running: boolean; started_at: string | null; finished_at: string | null; error: string | null; result: null | { seen: number; loaded: number; kept_as_edited: number; comments: number; linked_conversation: number; linked_contact: number; linked?: { users: number; cleaners: number } } }
export interface ConversationComplaints { complaints: Pick<ComplaintRecord, 'id' | 'title' | 'state'>[]; positive: { conversation_id: number; flagged_at: string; done_at: string | null } | null }

// What has kept clients before for this kind of complaint (the Complaint playbook).
export interface GuidanceOption { rung: string; name: string; saved: number | null; decided: number; avg_cost: number | null; n: number }
// Ranked responses from every similar past complaint (customer success brain, step 2).
export interface RankedOption {
  rank: number; response: string; label: string;
  group: 'threat_category' | 'threat' | 'cause_category' | 'cause' | 'category' | 'all'; group_label: string; group_cases: number;
  cases: number; decided: number; kept: number | null; kept_n: number | null; score: number; vs_group: number | null;
  happy: number | null; happy_n: number; heard: number;
  taken_when_offered: number | null; offered_answered: number; first_turned_down: number | null;
  avg_cost: number | null; from_conversations: number; grade: 'High' | 'Medium' | 'Low'; best_value?: boolean;
  kept_value?: number; net_value?: number; best_net?: boolean;
}
export interface Ranked { client_value?: number | null; groups: { key: string; label: string; cases: number; decided: number; kept: number | null }[]; options: RankedOption[]; considered: number }
export interface Guidance {
  ranked?: Ranked | null;
  threat?: 'none' | 'leave' | 'review';
  cause?: string | null;
  cause_label?: string | null;
  cause_cases?: number;
  cause_decided?: number;
  based_on?: 'cause' | 'category';
  available: boolean;
  reason?: string;
  category: string | null;
  label?: string;
  basis?: 'type' | 'notes';
  complaint_type?: string | null;
  window?: { from: string; to: string };
  escalation?: string | null;
  one_time?: boolean;
  cases?: number;
  typical?: string | null;
  saved?: number | null;
  decided?: number;
  avg_cost?: number | null;
  cheapest?: { name: string | null; saved: number | null; avg_cost: number | null; n: number; grade: 'High' | 'Medium' | 'Low'; reason: string } | null;
  options?: GuidanceOption[];
  one_time_stats?: { n: number; decided_90: number; rebooked_90: number | null; decided: number; rebooked_120: number | null } | null;
}

export interface AdjustmentMeta { categories: string[]; net_impacts: string[]; reason_max: number; sheet_url: string | null; mode: 'live' | 'sandbox' | 'not_set_up' }
export interface AdjustmentForm {
  cleaner_name: string; amount: string; category: string; reason: string; customer_name: string; net_impact: string;
  submitted_by: string; approved_by: string; customer_address: string; service_date: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.json();
}
const qs = (p: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();
  return s ? `?${s}` : '';
};

export const tracker = {
  meta: () => call<TrackerMeta>('GET', '/tracker/meta'),
  counts: () => call<Record<string, number>>('GET', '/tracker/counts'),
  list: (p: { view: string; sort?: string; dir?: string; q?: string }) => call<ComplaintList>('GET', `/tracker/complaints${qs(p)}`),
  get: (id: number) => call<ComplaintDetail>('GET', `/tracker/complaints/${id}`),
  guidance: (id: number) => call<Guidance>('GET', `/tracker/complaints/${id}/guidance`),
  create: (body: ComplaintPatch) => call<ComplaintDetail>('POST', '/tracker/complaints', body),
  patch: (id: number, body: ComplaintPatch) => call<ComplaintDetail>('PATCH', `/tracker/complaints/${id}`, body),
  bulk: (ids: number[], patch: ComplaintPatch) => call<{ updated: number }>('POST', '/tracker/complaints/bulk', { ids, patch }),
  comment: (id: number, body: string) => call<ComplaintComment>('POST', `/tracker/complaints/${id}/comments`, { body }),
  forConversation: (id: number) => call<ConversationComplaints>('GET', `/tracker/conversations/${id}`),
  forContact: (id: number) => call<(Pick<ComplaintRecord, 'id' | 'title' | 'state' | 'created_at'> & { status: string | null; original_service_date: string | null })[]>('GET', `/tracker/contacts/${id}/complaints`),
  positive: () => call<PositiveFeedback[]>('GET', '/tracker/positive-feedback'),
  setPositive: (conversationId: number, action: 'flag' | 'done' | 'clear') => call<{ positive: ConversationComplaints['positive'] }>('POST', `/tracker/positive-feedback/${conversationId}`, { action }),
  loadStatus: () => call<LoadStatus>('GET', '/tracker/kustomer/load'),
  startLoad: () => call<LoadStatus>('POST', '/tracker/kustomer/load', {}),
  linkNames: () => call<{ users: number; cleaners: number }>('POST', '/tracker/link-names', {}),
};

export const adjustments = {
  meta: () => call<AdjustmentMeta>('GET', '/adjustments/meta'),
  submit: (body: AdjustmentForm & { conversation_id?: number; contact_id?: number }) => call<{ outcome: 'sent' | 'sandbox'; row: number | null; note?: string }>('POST', '/adjustments', body),
};
