// Client for the Crew Planner (/api/crew on our own server). docs/crew-planner.md
import { ApiError, describeErrors } from '../api';

export type PrefType = 'PREF_CLEANER' | 'AVOID_CLEANER' | 'FEMALE_ONLY' | 'NO_TRAINEES' | 'CONSISTENT_CLEANER' | 'FIXED_TIME' | 'HOLD_UNPAID' | 'PENDING_CANCEL';
export type PrefSource = 'launch27_tag' | 'launch27_note' | 'continuity_history' | 'grace_manual';
export type PrefStatus = 'pending' | 'confirmed' | 'rejected';
export type PlannerStatus = 'active' | 'on_hold' | 'inactive';
export type Employment = 'employee' | 'contractor' | 'contractor_guaranteed';
export type CrewRole = 'none' | 'lead' | 'trainer' | 'trainee';
export type JobType = 'prepaid' | 'one_time' | 'move_in_out' | 'recurring' | 'deep_clean';

export const PREF_LABEL: Record<PrefType, string> = {
  PREF_CLEANER: 'Prefers',
  AVOID_CLEANER: 'Never send',
  FEMALE_ONLY: 'Female cleaner only',
  NO_TRAINEES: 'No trainees',
  CONSISTENT_CLEANER: 'Same cleaner every time',
  FIXED_TIME: "Don't move the time",
  HOLD_UNPAID: 'Hold: unpaid balance',
  PENDING_CANCEL: 'Cancelling (tentative)',
};
export const NAMES_CLEANERS: PrefType[] = ['PREF_CLEANER', 'AVOID_CLEANER'];
export const SOURCE_LABEL: Record<PrefSource, string> = {
  launch27_tag: 'Launch27 tag',
  launch27_note: 'Launch27 notes',
  continuity_history: 'Visit history',
  grace_manual: 'Added in the app',
};
export const STATUS_LABEL: Record<PlannerStatus, string> = { active: 'Active', on_hold: 'On hold', inactive: 'Inactive / left' };
export const EMPLOYMENT_LABEL: Record<Employment, string> = { employee: 'Employee', contractor: 'Contractor', contractor_guaranteed: 'Contractor, guaranteed hours' };
export const ROLE_LABEL: Record<CrewRole, string> = { none: '—', lead: 'Lead', trainer: 'Trainer', trainee: 'Trainee' };
export const JOB_LABEL: Record<JobType, string> = { prepaid: 'Prepaid', one_time: 'One-time', move_in_out: 'Move in/out', recurring: 'Recurring', deep_clean: 'Deep clean' };

export interface CrewCleaner {
  id: number;
  name: string;
  l27_name: string | null;
  in_launch27: boolean;
  l27_status: string | null;
  l27_status_label: string | null;
  location_ids: number[];
  weekly_hours: number | null;
  gender: 'F' | 'M' | null;
  gender_from: 'app' | 'launch27' | null;
  tier: 1 | 2 | 3 | null;
  tier_from: 'app' | 'launch27' | null;
  status: PlannerStatus;
  protected: boolean;
  low_performer: boolean;
  employment: Employment;
  crew_role: CrewRole;
  prefers_job_types: JobType[];
  aliases: string[];
  note: string | null;
  has_profile: boolean;
  rating_pct?: number | null; // admins only
}

export interface Pref {
  id: number;
  client_id: string;
  client_name: string | null;
  type: PrefType;
  cleaners: { id: number; name: string }[];
  note: string | null;
  source: PrefSource;
  source_text: string | null;
  status: PrefStatus;
  active: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
}

export interface SeedReport {
  cleaners: { set: string[]; already: string[]; unmatched: string[]; ambiguous: { name: string; matches: string[] }[] };
  prefs: { added: string[]; already: string[]; needs_cleaner: string[]; unmatched_clients: string[]; ambiguous_clients: { client: string; matches: number }[] };
  needs_decision: { what: string; why: string }[];
}

export interface CrewStatus {
  admin: boolean;
  counts: { pending: number; confirmed: number; profiles: number; areas: number };
  seed: { run_at: string; run_by: string | null; report: SeedReport } | null;
  last_ingest: { at: string; created: number } | null;
  snapshot_at: string | null;
  drive_times: 'estimated' | 'google';
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/crew${path}`, {
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
const qs = (p: Record<string, string | undefined | null>) => {
  const s = new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();
  return s ? `?${s}` : '';
};

export const crewApi = {
  status: () => call<CrewStatus>('GET', '/status'),
  cleaners: () => call<{ cleaners: CrewCleaner[] }>('GET', '/cleaners'),
  saveCleaner: (id: number, patch: Partial<CrewCleaner>) => call<unknown>('PATCH', `/cleaners/${id}`, patch),
  prefs: (p: { status?: PrefStatus | null; source?: PrefSource | null; q?: string | null } = {}) => call<{ counts: Record<PrefStatus, number>; prefs: Pref[] }>('GET', `/prefs${qs(p)}`),
  addPref: (body: { client_id: string | number; client_name?: string | null; type: PrefType; cleaner_ids?: number[]; note?: string | null }) => call<{ id: number }>('POST', '/prefs', body),
  prefAction: (id: number, action: 'confirm' | 'reject' | 'deactivate' | 'reactivate', edits: { cleaner_ids?: number[]; note?: string | null } = {}) => call<{ id: number }>('POST', `/prefs/${id}/${action}`, edits),
  bulk: (ids: number[], action: 'confirm' | 'reject') => call<{ done: number; skipped: { id: number; why: string }[] }>('POST', '/prefs/bulk', { ids, action }),
  scan: () => call<{ created: number }>('POST', '/prefs-scan'),
  areas: () => call<{ clusters: { fsa: string; cluster: string }[]; names: string[] }>('GET', '/areas'),
  saveArea: (fsa: string, cluster: string | null) => call<unknown>('PUT', `/areas/${encodeURIComponent(fsa)}`, { cluster }),
  loadSeed: () => call<SeedReport>('POST', '/seed'),
};
