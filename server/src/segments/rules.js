// Customer segments: pure rules over a customer's Launch27 bookings.
// Every customer is in exactly one segment; traits stack on top.

export const SEGMENTS = [
  { id: 'recurring', label: 'Recurring', group: 'active' },
  { id: 'risk', label: 'At risk', group: 'active' },
  { id: 'repeat', label: 'Repeat one-time', group: 'active' },
  { id: 'first', label: 'First-time', group: 'active' },
  { id: 'lapsedRec', label: 'Lapsed recurring', group: 'past' },
  { id: 'lapsedOne', label: 'Lapsed one-time', group: 'past' },
];
export const SEGMENT_IDS = SEGMENTS.map((s) => s.id);
export const TRAITS = [
  { id: 'prepaid', label: 'Prepaid' },
  { id: 'newplan', label: 'New on a plan' },
  { id: 'converted', label: 'Converted from one-time' },
  { id: 'vip', label: 'VIP' },
  { id: 'cancelled', label: 'Cancelled in last 12 months' },
];

export const DEFAULT_SEGMENT_SETTINGS = {
  risk_days: 45, // At risk -> Lapsed recurring this many days after the last clean
  first_days: 90, // First-time -> Lapsed one-time
  repeat_days: 180, // Repeat one-time -> Lapsed one-time
  new_plan_days: 60, // "New on a plan" trait
};

export function validateSegmentSettings(input = {}) {
  const out = { ...DEFAULT_SEGMENT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SEGMENT_SETTINGS)) {
    if (input[k] === undefined) continue;
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n < 7 || n > 730) throw new Error(`${k} must be a whole number of days between 7 and 730`);
    out[k] = n;
  }
  return out;
}

const DAY = 86_400_000;
const TORONTO = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
// Calendar date in Toronto (YYYY-MM-DD) for an ISO timestamp or Date.
export const torontoDate = (t) => TORONTO.format(new Date(t));
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

const isOneTime = (name) => /one\s*-?\s*time/i.test(name || '');
const isPrepaid = (name) => /prepaid/i.test(name || '');
const isVipTag = (t) => /^#?\s*vip\b/i.test(String(t?.name || '').trim());

// Launch27 booking -> the few fields the rules need.
export function slimBooking(b) {
  const u = b.user || {};
  return {
    id: b.id,
    customer_id: u.id ?? b.customer_id ?? null,
    name: u.name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.company_name || u.email || null,
    email: u.email || null,
    phone: b.phone || null,
    city: b.address?.city || null,
    vip: (u.tags_info || []).some(isVipTag),
    day: torontoDate(b.service_date),
    created: b.created_at ? torontoDate(b.created_at) : torontoDate(b.service_date),
    freq: b.frequency?.name || null,
    one: isOneTime(b.frequency?.name),
    prepaid: isPrepaid(b.frequency?.name),
    total: Number(b.summary?.total) || 0,
  };
}

// Classify one customer as of date `t` (YYYY-MM-DD).
// bookings: slimmed, non-cancelled bookings. opts.known: only count bookings created by t
// (rebuilding history). opts.everPlan: known from earlier runs. opts.cancelled: count of
// cancellations in the last 12 months.
export function classify(bookings, t, { settings = DEFAULT_SEGMENT_SETTINGS, known = false, everPlan = false, cancelled = 0 } = {}) {
  const list = (known ? bookings.filter((b) => b.created <= t) : bookings).slice().sort((a, b) => a.day.localeCompare(b.day));
  const past = list.filter((b) => b.day <= t);
  const future = list.filter((b) => b.day > t);
  const last = past.at(-1) || null;
  const next = future[0] || null;
  const planPast = past.some((b) => !b.one);
  const planFuture = future.some((b) => !b.one);
  const firstPlan = list.find((b) => !b.one) || null;
  const ever = everPlan || planPast || planFuture;

  let segment;
  if (planFuture) segment = 'recurring';
  else if (planPast || everPlan) segment = last && last.day >= addDays(t, -settings.risk_days) ? 'risk' : 'lapsedRec';
  else if (future.length) segment = past.length ? 'repeat' : 'first';
  else if (past.length >= 2) segment = last.day >= addDays(t, -settings.repeat_days) ? 'repeat' : 'lapsedOne';
  else if (past.length === 1) segment = last.day >= addDays(t, -settings.first_days) ? 'first' : 'lapsedOne';
  else segment = ever ? 'lapsedRec' : 'lapsedOne';

  const yearAgo = addDays(t, -365);
  const lastPrepaid = list.filter((b) => b.prepaid).at(-1)?.day || null;
  const traits = [];
  if (list.some((b) => b.prepaid && (b.day > t || b.day >= addDays(t, -60)))) traits.push('prepaid');
  if (segment === 'recurring' && firstPlan && firstPlan.day >= addDays(t, -settings.new_plan_days)) traits.push('newplan');
  if ((segment === 'recurring' || segment === 'risk') && firstPlan && list.some((b) => b.one && b.day < firstPlan.day)) traits.push('converted');
  if (list.some((b) => b.vip)) traits.push('vip');
  if (cancelled > 0) traits.push('cancelled');

  const latest = list.at(-1) || {};
  return {
    segment,
    traits,
    ever_plan: ever,
    plan: (next || last)?.freq || null,
    last_clean: last?.day || null,
    next_clean: next?.day || null,
    last_prepaid: lastPrepaid && lastPrepaid > t ? lastPrepaid : null,
    first_plan: firstPlan?.day || null,
    spend_12m: Math.round(past.filter((b) => b.day >= yearAgo).reduce((s, b) => s + b.total, 0) * 100) / 100,
    cleans_12m: past.filter((b) => b.day >= yearAgo).length,
    name: latest.name || null,
    email: latest.email || null,
    phone: [...list].reverse().find((b) => b.phone)?.phone || null,
    city: latest.city || null,
  };
}

// What staff should do next, and for At risk how many days are left before they lapse.
export function suggestion(row, t, settings = DEFAULT_SEGMENT_SETTINGS) {
  const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const since = row.last_clean ? daysBetween(row.last_clean, t) : null;
  switch (row.segment) {
    case 'recurring':
      if (row.traits?.includes('prepaid') && row.last_prepaid && daysBetween(t, row.last_prepaid) <= 30) return { text: `Last prepaid visit on the schedule is ${fmt(row.last_prepaid)}: ask about renewing` };
      if (row.traits?.includes('newplan')) return { text: 'New on a plan: check in after the next visit' };
      return { text: 'All good' };
    case 'risk':
      return { text: `Call: ${since ?? '?'} days since the last clean, nothing booked`, days_left: since === null ? null : Math.max(settings.risk_days - since, 0) };
    case 'repeat':
      return { text: row.next_clean ? 'Booked again: suggest a plan' : 'Offer a plan' };
    case 'first':
      if (row.next_clean && !row.last_clean) return { text: `First visit ${fmt(row.next_clean)}: send what to expect` };
      return { text: 'Ask for a rating, then offer a second clean' };
    case 'lapsedRec':
      return { text: 'Win-back offer' };
    default:
      return { text: 'Seasonal campaign' };
  }
}

// Group slimmed bookings by customer.
export function byCustomer(slim) {
  const map = new Map();
  for (const b of slim) {
    if (b.customer_id == null) continue;
    if (!map.has(b.customer_id)) map.set(b.customer_id, []);
    map.get(b.customer_id).push(b);
  }
  return map;
}

// Month-end dates (YYYY-MM-DD) for the `months` months before `today`, oldest first.
export function monthEnds(today, months = 12) {
  const [y, m] = today.split('-').map(Number);
  const out = [];
  for (let i = months; i >= 1; i--) out.push(new Date(Date.UTC(y, m - i, 0)).toISOString().slice(0, 10));
  return out.filter((d) => d < today);
}
