// Client for the Complaint Resolution Engine (/api/complaints on our own server).
import { ApiError, describeErrors } from '../api';

export type Outcome = 'saved' | 'partial_save' | 'lost' | 'pending' | 'rebooked' | 'not_rebooked';
export type Confidence = 'good' | 'fair' | 'thin' | 'none';

export type ExcludedReason = 'one_time' | 'unmatched' | 'too_recent' | 'no_outcome';
export interface OneTimeStats {
  n: number; ids: number[];
  decided: number; decided_ids: number[];
  decided_90: number; decided_90_ids: number[];
  rebooked_90: number | null; rebooked_90_n: number; rebooked_90_ids: number[];
  rebooked_120: number | null; rebooked_120_n: number; rebooked_120_ids: number[];
  too_early_ids: number[];
  confidence: Confidence;
}
// Every figure carries the ids of the cases behind it. Rates are shares of `decided`.
export interface OutcomeStats {
  n: number; ids: number[];
  decided: number; decided_ids: number[];
  saved: number | null; saved_n: number; saved_ids: number[];
  partial: number | null; partial_n: number; partial_ids: number[];
  lost: number | null; lost_n: number; lost_ids: number[];
  // A client who left is lost, review or no review. Whether they also left a 1-2 star review:
  lost_with_review_n: number; lost_with_review_ids: number[];
  lost_no_review_n: number; lost_no_review_ids: number[];
  excluded_n: number;
  excluded: Partial<Record<ExcludedReason, number[]>>;
  total_cost: number;
  avg_cost: number | null;
  avg_cost_decided: number | null;
  median_cost: number | null;
  confidence: Confidence;
  one_time: OneTimeStats;
}
// name is null when no response has 5 cases with a known outcome of its own: "Not enough data: use the standard ladder".
export interface Cheapest { rung: string | null; name: string | null; saved: number | null; saved_n: number; avg_cost: number | null; n: number; cases: number; ids: number[]; basis: 'compared' | 'not_enough'; grade: 'High' | 'Medium' | 'Low'; reason: string; usual?: string | null }

export interface Rung { rung: string; name: string; tier: string; action: string; label: string; amount?: number; pct?: number }

export interface Playbook {
  window: { from: string; to: string };
  totals: OutcomeStats & { cases: number; hard_routed: number; hard_routed_ids: number[]; by_source: Record<string, number>; total_cost: number };
  taxonomy: (OutcomeStats & {
    key: string;
    label: string;
    share: number | null;
    total_n: number;
    hard_routed: number;
    hard_routed_ids: number[];
    typical_rung: string | null;
    typical_name: string | null;
    tones: Record<string, number>;
    by_rung: (OutcomeStats & { rung: string; name: string })[];
    cheapest_that_works: Cheapest | null;
  })[];
  by_cause: (OutcomeStats & {
    key: string;
    label: string;
    group: string | null;
    share: number | null;
    total_n: number;
    hard_routed: number;
    hard_routed_ids: number[];
    typical_rung: string | null;
    typical_name: string | null;
    by_rung: (OutcomeStats & { rung: string; name: string })[];
    cheapest_that_works: Cheapest | null;
    contributing_n: number;
    contributing_ids: number[];
    set_by: Record<string, number>;
    by_category: { key: string; label: string; n: number; ids: number[] }[];
  })[];
  cause_groups: (OutcomeStats & { key: string; label: string; share: number | null })[];
  threats: (OutcomeStats & { key: string; label: string; share: number | null; by_response: (OutcomeStats & { response: string; label: string })[] })[];
  value_tiers: (OutcomeStats & { key: string; label: string; share: number | null; avg_spend: number | null; by_response: (OutcomeStats & { response: string; label: string })[] })[];
  value_unknown_ids: number[];
  funnel: {
    steps: { key: string; label: string; n: number; ids: number[]; of_total: number | null; dropped_n: number; dropped_ids: number[]; dropped_label: string | null }[];
    unmatched_share: number | null;
    unmatched_high: boolean;
    unmatched_reasons: { key: string; label: string; n: number; ids: number[] }[];
  };
  by_response: (OutcomeStats & { key: string; label: string; share: number | null; by_threat: (OutcomeStats & { response: string; label: string })[]; by_severity: (OutcomeStats & { response: string; label: string })[] })[];
  reviews: {
    imported: number; imported_negative: number; first_at: string | null; last_at: string | null;
    matched_ids: number[]; low_ids: number[]; high_ids: number[];
    threatened_ids: number[]; threatened_posted_ids: number[]; threatened_not_posted_ids: number[]; low_without_threat_ids: number[];
    low_by_response: { response: string; label: string; n: number; ids: number[] }[];
  };
  solutions: {
    enabled: boolean;
    read: number; read_ids: number[];
    no_thread: number; no_thread_ids: number[];
    not_yet: number;
    offers: {
      key: string; label: string;
      offered: number; offered_ids: number[];
      accepted: number; accepted_ids: number[];
      pushed_back: number; pushed_back_ids: number[];
      accept_rate: number | null;
      asked_for: number; asked_for_ids: number[];
      ended_happy: number | null; ended_happy_n: number; ended_heard: number; ended_happy_ids: number[];
      final: OutcomeStats;
    }[];
    endings: Record<'satisfied' | 'neutral' | 'unhappy' | 'unknown', number[]>;
    said_will_leave_ids: number[];
    pushed_back_first_ids: number[];
  };
  ladder: (Rung & OutcomeStats)[];
  reclean_vs_refund: { key: string; label: string; reclean: OutcomeStats; refund: OutcomeStats; neither: OutcomeStats; verdict: string }[];
  reclean_vs_refund_total: { reclean: OutcomeStats; refund: OutcomeStats; neither: OutcomeStats };
  like_for_like: {
    groups_compared: number;
    matched_pairs: number;
    reclean: { saved: number; avg_cost: number | null; n: number; ids: number[] } | null;
    refund: { saved: number; avg_cost: number | null; n: number; ids: number[] } | null;
    confidence: Confidence;
    verdict: string;
  };
  root_causes: null | {
    base_rate_per_100: number;
    visits: number;
    linked_complaints: number;
    linked_ids: number[];
    rows: { key: string; label: string; visits: number; complaints: number; case_ids: number[]; rate_per_100: number | null; vs_base: number | null; confidence: Confidence }[];
  };
  hard_routes: { key: string; label: string; n: number; ids: number[] }[];
  response: { first_response_median_hours: number | null; with_response_time: number; decided_by: Record<string, number> };
  baseline: {
    months: { month: string; revenue: number; cost: number; rate: number | null; cases: number; case_ids: number[]; refunds: number; credits: number; recleans: number; complete: boolean }[];
    included_months: string[];
    incomplete_months: string[];
    average: number | null;
    best: { month: string; rate: number | null } | null;
    worst: { month: string; rate: number | null } | null;
    default_target: number | null;
    caveat: string;
  };
  gaps: string[];
  thin_threshold: number;
  excluded_labels: Record<ExcludedReason, string>;
}

export interface CaseRow {
  id: number;
  source: string;
  opened_at: string;
  service_date: string | null;
  customer_name: string | null;
  l27_customer_id: number | null;
  l27_booking_id: number | null;
  category: string;
  tone: string | null;
  severity: number | null;
  hard_route: string | null;
  summary: string | null;
  status: string;
  source_status: string | null;
  classified_by: string;
  cause: string | null;
  contributing_causes: string[] | null;
  cause_by: CauseBy | null;
  total_cost: string | number;
  rungs: string | null;
  outcome_60: Outcome | null;
  outcome_120: Outcome | null;
  client_type: 'one_time' | 'recurring' | null;
  service: string | null;
  tenure_days: number | null;
  cleaner_name: string | null;
  original_url: string | null;
}

export interface CaseDetail extends CaseRow {
  areas_cited: string[];
  cause_evidence: string | null;
  exchanges: number | null;
  first_response_at: string | null;
  journey: Record<string, string | number | boolean | null> | null;
  resolutions: { rung: string | null; action: string; pct: number | null; amount: string | null; decided_by: string | null; approved_by: string | null; source: string; offered_at: string | null }[];
  costs: { kind: string; amount: string; source: string; estimated: boolean }[];
  outcomes: { day: number; outcome: Outcome; still_booking: boolean | null; next_booking_on: string | null; last_booking_on: string | null; repeat_case_id: number | null }[];
  also_seen_in: { id: number; source: string; opened_at: string }[];
  solution: null | {
    read_by: 'claude' | 'none';
    thread_messages: number;
    asked_for: string | null;
    offers: { kind: string; amount: number | null; pct: number | null; detail: string; client_response: string }[];
    final_kind: string | null;
    final_detail: string | null;
    client_end: string | null;
    said_will_leave: boolean | null;
    said_will_stay: boolean | null;
    handling: string | null;
    mined_at: string;
  };
}
// What we offered on a complaint (solution mining), in plain words.
export const OFFER_LABEL: Record<string, string> = {
  apology: 'Apology only', credit: 'Credit on a future clean', discount_next: 'Discount on the next clean', reclean: 'Reclean',
  partial_refund: 'Partial refund', full_refund: 'Full refund', same_cleaner: 'Their regular cleaner back', different_cleaner: 'A different cleaner',
  extra_time: 'Longer visit / more cleaners', free_add_on: 'Free add-on', damage_reimbursement: 'Damage reimbursement', manager_call: 'Call from a manager',
  other: 'Something else', nothing_specific: 'Nothing specific',
};
export const RESPONSE_LABEL: Record<string, string> = { accepted: 'took it', declined: 'turned it down', countered: 'asked for something else', no_reply: 'no reply', unclear: 'unclear' };
export const ENDING_LABEL: Record<string, string> = { satisfied: 'Happy', neutral: 'Neutral', unhappy: 'Still unhappy', unknown: 'Never wrote back' };

export interface Settings {
  approval_preset: 'today' | 'target';
  max_rung: Record<string, string>;
  roles: Record<string, string>;
  hard_route_role: string;
  credit_expiry_days: number;
  budget: { target_pct: number | null; below_average_by: number; amber_at: number; red_at: number; alert_slack_user: string | null; qbo_tolerance: number };
  costs: { cleaner_hourly_default: number; margin_per_hour_default: number; travel_per_visit: number; reclean_default_hours: number; reclean_spot_share: number };
  pilot_months: number;
  auto: { enabled: boolean; history_months: number };
}

export interface Status {
  running: boolean;
  sources: Record<string, string>;
  window: { from: string; to: string };
  auto: { enabled: boolean; history_months: number; next: null | { kind: 'history' | 'recent'; from: string; to: string; label: string }; last_daily_update: string | null; overnight: boolean };
  mined: { window_from: string; window_to: string; finished_at: string | null; status: string }[];
  last_run: null | { id: number; started_at: string; finished_at: string | null; status: string; window_from: string; window_to: string; log: { at: string; level: string; msg: string }[] };
}

export interface ClientRow {
  l27_customer_id: number;
  name: string | null;
  complaints: number;
  last_complaint: string;
  last_category: string;
  total_cost: number;
  avg_severity: number;
  status: Outcome;
  case_id: number;
}
export interface Clients {
  repeat: (ClientRow & { low_severity: boolean; still_with_us: boolean })[];
  at_risk: (ClientRow & { score: number; reasons: string[]; next_booking_on: string | null })[];
  review_mentions: (ClientRow & { mentioned_on: string })[];
  google_reviews_connected: boolean;
  clients_with_complaints: number;
}

export interface ReviewsSummary {
  imported: number; negative: number; matched: number; negative_matched: number; first_at: string | null; last_at: string | null;
  low: { review_id: string; reviewer_name: string | null; stars: number; comment: string | null; created_at: string; replied: boolean; case_id: number | null; contact_id: number | null; case_opened_at: string | null; case_category: string | null }[];
}
export type Verdict = 'correct' | 'wrong_category' | 'not_complaint';
// Root causes: why it happened (the category is what the client complained about).
export type CauseBy = 'rules' | 'claude' | 'facts' | 'human';
export interface CodebookCause { key: string; group: string; label: string; definition: string; examples: string[]; not_when: string }
export interface Codebook { groups: { key: string; label: string }[]; causes: CodebookCause[] }
export const CAUSE_BY_LABEL: Record<string, string> = { rules: 'Keyword rules', claude: 'Claude', facts: 'Launch27 facts', human: 'A person', none: 'Not set' };
export interface ReviewItem {
  id: number;
  source: string;
  opened_at: string;
  service_date: string | null;
  customer_name: string | null;
  category: string;
  tone: string | null;
  severity: number | null;
  hard_route: string | null;
  summary: string | null;
  source_status: string | null;
  classified_by: string;
  areas_cited: string[];
  rungs: string | null;
  title: string | null;
  text: string | null;
  resolution_text: string | null;
  rating: number | null;
  original_url: string | null;
  cause: string | null;
  contributing_causes: string[] | null;
  cause_evidence: string | null;
  cause_by: CauseBy | null;
  cleaner_name: string | null;
  facts: { cause: string; text: string }[];
}
export interface ReviewTally { key: string; checked: number; correct: number; wrong_category: number; not_complaint: number; accuracy: number | null; enough: boolean }
export interface CauseTally { key: string; checked: number; correct: number; wrong: number; accuracy: number | null; enough: boolean }
export interface ReviewStats {
  total: Omit<ReviewTally, 'key'>;
  cause: { total: Omit<CauseTally, 'key'>; by_cause: CauseTally[]; by_setter: CauseTally[]; confusions: { from: string; to: string; n: number }[] };
  by_category: (ReviewTally & { waiting: number })[];
  by_source: ReviewTally[];
  by_classifier: ReviewTally[];
  confusions: { from: string; to: string; n: number }[];
  min_checks: number;
  waiting: number;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/complaints${path}`, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) window.dispatchEvent(new Event('l27:logged-out'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, describeErrors(data) || `${res.status} ${res.statusText}`, data);
  }
  return res.json();
}

const qs = (w?: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams(Object.entries(w || {}).filter(([, v]) => v) .map(([k, v]) => [k, String(v)])).toString();
  return p ? `?${p}` : '';
};

export const complaintsApi = {
  status: () => call<Status>('GET', '/status'),
  playbook: (w?: { from?: string; to?: string }) => call<Playbook>('GET', `/playbook${qs(w)}`),
  cases: (w?: { from?: string; to?: string; category?: string; cause?: string }) => call<CaseRow[]>('GET', `/cases${qs(w)}`),
  codebook: () => call<Codebook>('GET', '/codebook'),
  reviews: () => call<ReviewsSummary>('GET', '/reviews'),
  importReviews: (file: unknown) => call<{ read: number; added: number; updated: number; matched: number; summary: ReviewsSummary }>('POST', '/reviews/import', file),
  clients: () => call<Clients>('GET', '/clients'),
  case: (id: number) => call<CaseDetail>('GET', `/cases/${id}`),
  reclassify: (id: number, patch: { category?: string; hard_route?: string | null }) => call<CaseDetail>('PATCH', `/cases/${id}`, patch),
  run: (w?: { from?: string; to?: string }) => call<{ started: boolean }>('POST', '/run', w || {}),
  review: (w?: { category?: string; source?: string; cause?: string; per?: number }) => call<{ queue: ReviewItem[]; stats: ReviewStats }>('GET', `/review${qs(w)}`),
  submitReview: (id: number, body: { verdict: Verdict; category?: string; cause?: string; contributing?: string[] }) => call<{ ok: boolean; stats: ReviewStats }>('POST', `/cases/${id}/review`, body),
  settings: () => call<{ settings: Settings; rungs: Rung[]; presets: Record<string, { label: string }>; categories: string[]; hard_routes: Record<string, string> }>('GET', '/settings'),
  saveSettings: (s: Settings) => call<{ settings: Settings }>('PUT', '/settings', s),
};

export const OUTCOME_LABEL: Record<string, string> = { saved: 'Saved', partial_save: 'Lost', lost: 'Lost', pending: 'Too early', rebooked: 'Booked again', not_rebooked: "Didn't book again" };
// Plain names for what we did. The L-codes stay behind the scenes (approval limits).
export const RUNG_NAME: Record<string, string> = {
  L0: 'Apology only', L1: '$5 credit', L2: '$10 credit', L3: 'Reclean', L4: 'Small refund (up to ~20%)', L5: 'Partial refund (~25–40%)', L6: 'Half refund', L7: 'Full refund (over half)',
  damage_reimbursement: 'Damage reimbursement', damage: 'Damage reimbursement', refund: 'Refund', credit: 'Credit', reclean_full: 'Reclean', reclean_spot: 'Spot reclean', apology: 'Apology only',
};
export const whatWeDid = (rungs: string | null) => (rungs ? [...new Set(rungs.split(', ').map((r) => RUNG_NAME[r] || r))].join(', ') : 'Apology only');
export const TONE_LABEL: Record<string, string> = { mild: 'Mild', frustrated: 'Frustrated', angry: 'Angry', threat_leave: 'Threatens to leave', threat_review: 'Threatens a review' };
export const SOURCE_LABEL: Record<string, string> = { kustomer: 'Kustomer', gmail: 'info@ email', slack: 'Slack refund post', launch27_rating: 'Launch27 rating', ops_inbox: 'Ops inbox', manual: 'Manual', conversation: 'from the conversation' };
