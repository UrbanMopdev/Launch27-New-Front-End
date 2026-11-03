// Shared pieces for customer segments: labels, pills, dates, the "updated" line.
import type { Outcome, SegmentId, SegmentSummary, TraitId } from './api';

export const SEGMENT_LABEL: Record<SegmentId | 'new', string> = {
  recurring: 'Recurring',
  risk: 'At risk',
  repeat: 'Repeat one-time',
  first: 'First-time',
  lapsedRec: 'Lapsed recurring',
  lapsedOne: 'Lapsed one-time',
  new: 'New customer',
};

export const SEGMENT_HELP: Record<SegmentId, (s: SegmentSummary['settings']) => string> = {
  recurring: () => 'On a plan with a clean booked.',
  risk: (s) => `Was on a plan, cleaned in the last ${s.risk_days} days, nothing booked next.`,
  repeat: (s) => `Two or more one-time cleans, the latest within ${Math.round(s.repeat_days / 30)} months. Ready for a plan.`,
  first: (s) => `One clean in the last ${s.first_days} days, or their first is coming up.`,
  lapsedRec: (s) => `Left a plan more than ${s.risk_days} days ago.`,
  lapsedOne: (s) => `Last one-time clean over ${s.first_days} days ago.`,
};

export const TRAIT_LABEL: Record<TraitId, string> = {
  prepaid: 'Prepaid',
  newplan: 'New on a plan',
  converted: 'Converted from one-time',
  vip: 'VIP',
  cancelled: 'Cancelled in last 12 months',
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  rebooked: 'Rebooked',
  pause: 'Travelling / pause',
  price: 'Price',
  quality: 'Quality',
  cleaner: 'Cleaner change',
  moved: 'Moved',
  no_answer: 'No answer',
  other: 'Other',
  snoozed: 'Snoozed',
};

export function SegmentPill({ segment, suffix }: { segment: SegmentId | 'new'; suffix?: string }) {
  return (
    <span className={`seg-pill seg-${segment}`}>
      {SEGMENT_LABEL[segment]}
      {suffix && <span className="seg-pill-suffix"> · {suffix}</span>}
    </span>
  );
}

export function TraitTag({ trait }: { trait: TraitId }) {
  return <span className="seg-trait">{TRAIT_LABEL[trait]}</span>;
}

// 'YYYY-MM-DD' -> 'Nov 7' (or 'Nov 7, 2025' when not this year).
export function shortDate(d: string | null | undefined, today = new Date()): string {
  if (!d) return '—';
  const dt = new Date(`${d}T12:00:00Z`);
  const sameYear = dt.getUTCFullYear() === today.getFullYear();
  return dt.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}

export const money = (n: number) => n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
export const pct = (n: number) => `${Math.round(n * 100)}%`;

export function UpdatedLine({ summary }: { summary?: SegmentSummary }) {
  if (!summary) return null;
  if (summary.running && !summary.updated_at) return <span className="muted small">Working out segments for the first time…</span>;
  const at = summary.updated_at ? new Date(summary.updated_at) : null;
  const when = at ? at.toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  return (
    <span className="muted small seg-updated">
      Updated {when}
      {summary.running ? ' · updating now…' : ' · next update tonight'} · bookings made in this app count right away
      {summary.last_error && <span className="warn"> · last update failed: {summary.last_error}</span>}
    </span>
  );
}
