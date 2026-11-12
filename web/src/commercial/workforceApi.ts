// Client for /api/commercial/workforce: the Commercial team, the weekly plan of moves, open
// slots and partner availability files. Reads live planner data; saves only the team's choices.
import { ApiError, describeErrors } from '../api';

export type MoveStatus = 'proposed' | 'approved' | 'done' | 'hold';
export interface Who { id: number; name: string }
export interface Candidate extends Who { added_km: number | null; served: boolean; free_hours?: number }
export interface SeriesInfo { key: string; client: string; account: string; category: string; weekday: number; start: number; duration: number; rhythm: string; addr: string | null; area: string | null; location_id: number | null }
export interface Action extends SeriesInfo { dates: string[]; kind: 'move' | 'nocover' | 'stay' | 'hold'; state: MoveStatus; end: string | null; holders: Who[]; pick: Candidate | null; candidates: Candidate[] }
export interface Near { km: number; before: boolean; time: number; label: string }
export interface Unassigned extends SeriesInfo { dates: string[]; visit_keys: string[]; commercial: (Who & { near: Near | null })[]; others: (Who & { near: Near | null })[] }
export interface Load { id: number; name: string; available_hours: number; commercial_hours: number; residential_hours: number; planned_hours: number; km_now: number; km_planned: number; has_hours: boolean; last_day: string | null }
export type BlockType = 'com' | 'res' | 'in' | 'out' | 'stay' | 'nocover' | 'off';
export interface BoardRow { id: number; name: string; commercial: boolean; days: { date: string; window: [number, number] | null; blocks: { start: number; end: number; type: BlockType; label: string }[] }[] }
export interface Plan {
  today: string; taken_at: string; week: string; week_end: string; transition_rule: boolean;
  totals: { visits: number; hours: number; on_team_share: number; move: number; nocover: number; stay: number; hold: number; unassigned: number; nocover_hours: number; team: number; residential_on_team: number; residential_on_team_hours: number };
  actions: Action[]; unassigned: Unassigned[]; load: Load[]; peak: Record<string, number>;
  off: { cleaner: Who; date: string; start: number; end: number; label: string; why: string }[];
  clashes: { cleaner: Who; date: string; start: number; a: string; b: string }[];
  tight: { cleaner: Who; date: string; from: string; to: string; gap: number; need: number; km: number }[];
  board: BoardRow[]; no_cleaner: { date: string; start: number; end: number; label: string; try: string | null }[];
}
export interface TeamRow { id: number; name: string; status: string; assignable: boolean; commercial_hours: number; residential_hours: number; share: number; suggested: boolean; ticked: boolean | null; commercial: boolean; upcoming_commercial: number; accounts: number; location_ids: number[]; has_hours: boolean; last_day: string | null }
export interface Team { today: string; taken_at: string; threshold: number; cleaners: TeamRow[] }
export interface PartnerSettings { accounts: Record<string, string[]>; showNames: boolean; showOwnAddresses: boolean; showOtherPartners: boolean; weeks: number; days: number[]; slots: [number, number][]; contact: string }
export interface Suggestion { cleaner_id: number; cleaner: string; area: string; day: number; start: number; duration: number; first: string; freq: number; near: { km: number; before: boolean; time: number; kind: 'C' | 'R'; account: string; addr: string } | null; tight: boolean; missing: string[] }
export interface Slots {
  today: string; taken_at: string; weeks: string[]; days: number[]; slots: [number, number][]; cleaners: number;
  grid: { every_week: string[]; some_weeks: { cleaner: string; free: number; of: number }[] }[][];
  placed: { fsa: string; name: string; area: string } | null; suggestions: Suggestion[] | null; partner: PartnerSettings;
}
export interface Scope { locations: number[]; cornwall: number[] }

const qs = (s: Scope, extra: Record<string, string | number | null | undefined> = {}) => {
  const p = new URLSearchParams({ locations: s.locations.join(','), cornwall: s.cornwall.join(',') });
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  return `?${p}`;
};
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/commercial/workforce${path}`, { credentials: 'same-origin', ...init, headers: init?.body ? { 'content-type': 'application/json' } : undefined });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.json();
}
const put = (path: string, body: unknown) => call<unknown>(path, { method: 'PUT', body: JSON.stringify(body) });

export const workforceApi = {
  team: (s: Scope) => call<Team>(`/team${qs(s)}`),
  plan: (s: Scope, week: string | null) => call<Plan>(`/plan${qs(s, { week })}`),
  slots: (s: Scope, find?: { postal: string; freq: number; day: number | null }) => call<Slots>(`/slots${qs(s, find ? { postal: find.postal, freq: find.freq, day: find.day } : {})}`),
  setCleaner: (id: number, patch: { commercial?: boolean | null; last_day?: string | null }) => put(`/cleaners/${id}`, patch),
  setMove: (key: string, patch: { status?: MoveStatus; assignee_id?: number | null; ends_on?: string | null }) => put('/moves', { key, ...patch }),
  setSettings: (patch: { transitionRule?: boolean; partner?: Partial<Pick<PartnerSettings, 'showNames' | 'showOwnAddresses' | 'showOtherPartners' | 'weeks' | 'contact'>> }) => put('/settings', patch),
  /** Downloads one partner's availability page (leads only). */
  async partnerFile(s: Scope, partner: string) {
    const res = await fetch(`/api/commercial/workforce/partner-file${qs(s, { partner })}`, { credentials: 'same-origin' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
    }
    const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || `urbanmop-availability-${partner.toLowerCase()}.html`;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};
