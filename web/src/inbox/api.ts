// Client for the support workspace API (/api on our own server).
import { ApiError, describeErrors } from '../api';

export type Channel = 'email' | 'sms' | 'voice' | 'chat';
export type Status = 'open' | 'snoozed' | 'done';
export type Role = 'customer' | 'cleaner' | 'applicant' | 'system';
export type Presence = 'available' | 'busy' | 'offline';

export interface User {
  id: number;
  email: string;
  name: string | null;
  role: 'agent' | 'supervisor' | 'admin';
  presence: Presence;
  queues?: { id: number; slug: string; name: string }[];
  open_count?: number;
  queue_ids?: number[];
  status?: (AgentStatus & { status_since: string | null }) | null;
  statuses?: AgentStatus[];
}

export type StatusKind = 'available' | 'away' | 'offline';
export interface AgentStatus {
  id: number;
  slug: string;
  name: string;
  kind: StatusKind;
  color: string;
  keeps_work?: boolean;
  max_minutes: number | null;
  selectable: boolean;
  position?: number;
  in_use?: number;
}
export type Capacity = Partial<Record<'email' | 'sms' | 'chat' | 'voice', number>>;
export interface Team {
  id?: number;
  name: string;
  description: string | null;
  lead_user_id: number | null;
  member_ids: number[];
  queue_ids: number[];
}
export interface QueueSettings extends Queue {
  position: number;
  routing_mode: 'least_busy' | 'round_robin' | 'manual';
  schedule_id: number | null;
  default_sla_id: number | null;
  overflow_minutes: number | null;
  overflow_queue_id: number | null;
  priority_boost: number;
}
export interface Schedule {
  id?: number;
  name: string;
  time_zone: string;
  week: Record<string, [string, string] | null>;
  is_default: boolean;
}
export interface WorkspaceSettings {
  default_capacity: Capacity;
  offline_returns_work: boolean;
  auto_offline_idle_minutes: number;
  pull_waiting_on_available: boolean;
  assign_on_reply: boolean;
  reopen_to_previous_owner: boolean;
  reopen_window_hours: number;
  require_disposition: boolean;
  alert_on_long_away: boolean;
  settings_editors: SettingsEditors;
}
export type SettingsEditors = 'everyone' | 'supervisors' | 'admins';

export interface HistoryEntry {
  id: number;
  action: string;
  object_type: string;
  object_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
  actor_email: string | null;
}
export interface WorkforceAgent {
  id: number;
  email: string;
  name: string | null;
  role: User['role'];
  active: boolean;
  capacity: Capacity;
  status_id: number | null;
  status_since: string | null;
  queue_ids: number[];
  team_ids: number[];
}
export interface QaCopySummary {
  created_at: string;
  window: { from: string; to: string };
  bookings: number;
  customers: number;
  cleaners: number;
}
export interface QaCopyStatus {
  env: string;
  can_send: boolean;
  receiving: boolean;
  current: QaCopySummary | null;
  job: { state: 'idle' | 'running' | 'done' | 'failed'; started_at?: string; finished_at?: string; by?: string; step?: string; summary?: QaCopySummary; error?: string } | null;
}

export interface Workforce {
  statuses: AgentStatus[];
  teams: Team[];
  queues: QueueSettings[];
  schedules: Schedule[];
  sla_policies: { id: number; slug: string; name: string }[];
  settings: WorkspaceSettings;
  channels: ('email' | 'sms' | 'chat' | 'voice')[];
  agents: WorkforceAgent[];
}

export interface Queue {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  restricted: boolean;
}

export interface SlaPolicy {
  id: number;
  slug: string;
  name: string;
  first_response_minutes: number;
  warn_minutes: number;
  business_hours: boolean;
}

export interface Disposition {
  audience?: string;
  reason?: string;
  outcome?: string;
  note?: string;
  cancellation_reason?: string;
}

export interface Complaint {
  booking_id?: number | null;
  cleaner?: string | null;
  issue?: string;
  outcome?: 'return clean' | 'credit' | 'refund' | 'none' | 'pending';
  monetary_impact?: number | null;
  status?: 'open' | 'resolved';
}

export interface ConversationRow {
  id: number;
  channel: Channel;
  status: Status;
  subject: string | null;
  last_preview: string | null;
  last_message_at: string;
  priority: number;
  sla_due_at: string | null;
  sla_breached_at: string | null;
  awaiting_reply_since: string | null;
  l27_booking_id: number | null;
  needs_match: boolean;
  their_identity: string | null;
  our_identity: string | null;
  snooze_until: string | null;
  queue_id: number | null;
  queue_name: string | null;
  owner_id: number | null;
  owner_name: string | null;
  contact_id: number | null;
  contact_name: string | null;
  contact_roles: Role[] | null;
  has_complaint: boolean;
}

export interface Conversation extends Omit<ConversationRow, 'queue_name' | 'owner_name' | 'contact_name' | 'contact_roles' | 'has_complaint'> {
  disposition: Disposition | null;
  complaint: Complaint | null;
  routed_by: string | null;
  first_response_at: string | null;
  created_at: string;
  reopened_count: number;
  sla_policy_id: number | null;
}

export interface Message {
  id: number;
  conversation_id: number;
  kind: 'message' | 'note' | 'call' | 'event';
  direction: 'in' | 'out' | null;
  channel: Channel | null;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body: string | null;
  author_id: number | null;
  author_name: string | null;
  delivery_state: string | null;
  meta: Record<string, unknown> & { note?: string; result?: string; duration_seconds?: number; recording_url?: string; type?: string };
  created_at: string;
}

export interface Identity {
  id: number;
  contact_id: number;
  kind: 'email' | 'phone';
  value: string;
  label: string | null;
  opted_out: boolean;
}

export interface Contact {
  id: number;
  name: string | null;
  roles: Role[];
  l27_customer_id: number | null;
  l27_team_id: number | null;
  lead_stage: string | null;
  lead_source: string | null;
  communication_preference: string | null;
  notes: string | null;
  identities: Identity[];
  conversations?: (Pick<Conversation, 'id' | 'channel' | 'status' | 'subject' | 'l27_booking_id' | 'disposition' | 'complaint'> & { last_preview: string | null; last_message_at: string })[];
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  contact: Contact | null;
  others: { id: number; channel: Channel; status: Status; subject: string | null; last_preview: string | null; last_message_at: string; l27_booking_id: number | null }[];
  queue: Queue | null;
  owner: { id: number; name: string | null; email: string; presence: Presence } | null;
  sla_policy: SlaPolicy | null;
  candidates: Contact[];
}

export interface Canned {
  id: number;
  shortcut: string;
  title: string;
  body: string;
  channels: Channel[];
}

export interface Meta {
  queues: Queue[];
  sla_policies: SlaPolicy[];
  dispositions: { audience: string[]; reason: string[]; outcome: string[]; cancellationReasons: string[] };
  canned: Canned[];
  identities: { email: string[]; sms: string[] };
  connected_channels: Channel[];
  ringcentral: { clientId: string; appServer: string | null } | null;
  holidays: { day: string; name: string }[];
}

export interface Counts {
  mine: number;
  unassigned: number;
  breached: number;
  needs_match: number;
  mentions: number;
  queues: Record<string, number>;
}

export interface Rule {
  id?: number;
  position?: number;
  name: string;
  enabled: boolean;
  conditions: Record<string, unknown>;
  action: Record<string, unknown>;
  replaces?: string | null;
}

export interface Notification {
  id: number;
  kind: string;
  conversation_id: number | null;
  text: string;
  read_at: string | null;
  created_at: string;
  contact_name: string | null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
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

export const inbox = {
  me: () => call<User>('GET', '/me'),
  setPresence: (presence: Presence) => call<{ presence: Presence; requeued: number }>('PUT', '/me/presence', { presence }),
  rename: (name: string) => call<User>('PATCH', '/me', { name }),
  users: () => call<User[]>('GET', '/users'),
  updateUser: (id: number, patch: { role?: string; queue_ids?: number[]; name?: string; team_ids?: number[]; capacity?: Capacity; active?: boolean }) => call<User>('PATCH', `/users/${id}`, patch),
  setStatus: (status_id: number) => call<{ status_id: number; status: string; presence: Presence; requeued: number }>('PUT', '/me/status', { status_id }),
  setUserStatus: (userId: number, status_id: number) => call<{ requeued: number }>('PUT', `/users/${userId}/status`, { status_id }),
  workforce: () => call<Workforce>('GET', '/admin/workforce'),
  saveSettings: (patch: Partial<WorkspaceSettings>) => call<WorkspaceSettings>('PUT', '/admin/settings', patch),
  saveStatuses: (statuses: Partial<AgentStatus>[]) => call<AgentStatus[]>('PUT', '/admin/statuses', { statuses }),
  saveTeams: (teams: Team[]) => call<void>('PUT', '/admin/teams', { teams }),
  createQueue: (name: string, description?: string) => call<QueueSettings>('POST', '/admin/queues', { name, description }),
  updateQueue: (id: number, patch: Partial<QueueSettings>) => call<QueueSettings>('PATCH', `/admin/queues/${id}`, patch),
  qaCopy: () => call<QaCopyStatus>('GET', '/admin/qa-copy'),
  sendQaCopy: () => call<{ job: QaCopyStatus['job'] }>('POST', '/admin/qa-copy'),
  clearQaCopy: () => call<void>('DELETE', '/admin/qa-copy'),
  saveSchedule: (s: Schedule) => call<Schedule>('PUT', s.id ? `/admin/schedules/${s.id}` : '/admin/schedules', s),
  meta: () => call<Meta>('GET', '/meta'),
  counts: () => call<Counts>('GET', '/counts'),
  list: (params: { view?: string; status?: string; channel?: string; role?: string; q?: string; contact_id?: number; booking_id?: number }) => call<ConversationRow[]>('GET', `/conversations${qs(params)}`),
  get: (id: number) => call<ConversationDetail>('GET', `/conversations/${id}`),
  reply: (id: number, body: { body: string; channel?: Channel; to?: string; subject?: string; from?: string }) => call<Message>('POST', `/conversations/${id}/messages`, body),
  note: (id: number, body: string) => call<Message>('POST', `/conversations/${id}/notes`, { body }),
  addEvent: (id: number, text: string, meta: Record<string, unknown> = {}) => call<Message>('POST', `/conversations/${id}/events`, { text, meta }),
  patch: (id: number, patch: Partial<{ status: Status; snooze_until: string; disposition: Disposition; queue_id: number; priority: number; l27_booking_id: number | null; complaint: Complaint | null; subject: string }>) => call<Conversation>('PATCH', `/conversations/${id}`, patch),
  claim: (id: number) => call<Conversation>('POST', `/conversations/${id}/claim`),
  assign: (id: number, userId: number | null, reason?: string) => call<Conversation>('POST', `/conversations/${id}/assign`, { user_id: userId, reason }),
  match: (id: number, contactId: number) => call<Conversation>('POST', `/conversations/${id}/match`, { contact_id: contactId }),
  start: (body: { contact_id: number; channel: 'email' | 'sms'; to?: string; from?: string; subject?: string; body?: string; l27_booking_id?: number }) => call<Conversation>('POST', '/conversations', body),
  contact: (id: number) => call<Contact>('GET', `/contacts/${id}`),
  findContacts: (q: string) => call<Contact[]>('GET', `/contacts${qs({ q })}`),
  createContact: (body: { name: string; roles: Role[]; email?: string; phone?: string }) => call<Contact>('POST', '/contacts', body),
  updateContact: (id: number, patch: Partial<Omit<Contact, 'id' | 'identities' | 'conversations'>>) => call<Contact>('PATCH', `/contacts/${id}`, patch),
  addIdentity: (id: number, kind: 'email' | 'phone', value: string, label?: string) => call<Identity>('POST', `/contacts/${id}/identities`, { kind, value, label }),
  setOptOut: (identityId: number, optedOut: boolean) => call<Identity>('PATCH', `/identities/${identityId}`, { opted_out: optedOut }),
  fromL27: (body: { customer_id?: number; team_id?: number }) => call<Contact>('POST', '/contacts/from-l27', body),
  search: (q: string) => call<{ contacts: (Pick<Contact, 'id' | 'name' | 'roles' | 'l27_customer_id' | 'l27_team_id'> & { identities: string | null })[]; conversations: { id: number; channel: Channel; status: Status; subject: string | null; contact_name: string | null; snippet: string | null; last_message_at: string }[] }>('GET', `/search${qs({ q })}`),
  notifications: () => call<Notification[]>('GET', '/notifications'),
  readNotifications: () => call<void>('POST', '/notifications/read'),
  supervisor: () => call<{ queues: { id: number; name: string; slug: string; open: number; unassigned: number; breached: number; oldest_waiting: string | null; done_today: number }[]; agents: { id: number; name: string | null; email: string; presence: Presence; role: string; open: number; breached: number; done_today: number; status_id: number | null; status: string | null; status_kind: StatusKind | null; status_color: string | null; status_max: number | null; status_since: string | null; away_minutes_today: number }[]; first_response: { median_minutes: number | null; n: number } }>('GET', '/supervisor'),
  rules: () => call<{ rules: Rule[]; warnings: { ruleId: number; message: string }[] }>('GET', '/admin/rules'),
  saveRules: (rules: Rule[]) => call<{ rules: Rule[]; warnings: { ruleId: number; message: string }[] }>('PUT', '/admin/rules', { rules }),
  testRules: (body: { channel: Channel; to?: string; from: string; subject?: string; body?: string; roles?: Role[]; lead_stage?: string; rules?: Rule[] }) => call<{ rule: string | null; action: Record<string, unknown> }>('POST', '/admin/rules/test', body),
  saveCanned: (c: Partial<Canned>) => call<Canned>('PUT', `/admin/canned${c.id ? `/${c.id}` : ''}`, c),
  deleteCanned: (id: number) => call<void>('DELETE', `/admin/canned/${id}`),
  history: () => call<HistoryEntry[]>('GET', '/admin/history'),
  saveSla: (id: number, patch: { first_response_minutes: number; warn_minutes?: number; business_hours?: boolean }) => call<SlaPolicy>('PUT', `/admin/sla/${id}`, patch),
  simulate: (body: { channel: Channel; from: string; to?: string; subject?: string; body: string; from_name?: string; thread_key?: string }) => call<{ conversationId: number; isNew: boolean; reopened: boolean }>('POST', '/simulate/inbound', body),
  logCall: (body: Record<string, unknown>) => call<{ conversationId: number }>('POST', '/calls', body),
  lookup: (kind: 'phone' | 'email', value: string) => call<{ contacts: Contact[]; open: { id: number; channel: Channel; subject: string | null }[]; l27: { name: string; roles: Role[] } | null }>('GET', `/lookup${qs({ kind, value })}`),
};
