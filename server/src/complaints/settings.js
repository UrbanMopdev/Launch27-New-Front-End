// Complaint rules: the resolution ladder, who can approve what, the refund budget and the
// cost assumptions. Stored as one JSON document (complaint_settings); these are the
// defaults. Switching from today's setup to "Jesse as Office Manager" is a settings change:
// assign the office_manager role and pick the 'target' approval preset.

export const RUNGS = [
  { rung: 'L0', name: 'Apology only', tier: 'Easy', action: 'apology', label: 'Acknowledge, apologise, log it, flag the cleaner' },
  { rung: 'L1', name: '$5 credit', tier: 'Easy', action: 'credit', amount: 5, label: '$5 off next booking' },
  { rung: 'L2', name: '$10 credit', tier: 'Easy', action: 'credit', amount: 10, label: '$10 off next booking' },
  { rung: 'L3', name: 'Reclean', tier: 'Easy–Med', action: 'reclean', label: 'Reclean (spot or full)' },
  { rung: 'L4', name: 'Small refund (up to ~20%)', tier: 'Medium', action: 'refund', pct: 15, label: '15% refund' },
  { rung: 'L5', name: 'Partial refund (~25–40%)', tier: 'Medium', action: 'refund', pct: 25, label: '25% refund' },
  { rung: 'L6', name: 'Half refund', tier: 'High', action: 'refund', pct: 50, label: '50% refund' },
  { rung: 'L7', name: 'Full refund (over half)', tier: 'Extreme', action: 'refund', pct: 100, label: 'Full refund (anything above 50%)' },
];
const ORDER = RUNGS.map((r) => r.rung);
export const rungName = (rung) => RUNGS.find((r) => r.rung === rung)?.name || (rung === 'damage' ? 'Damage reimbursement' : rung || 'Apology only');

// Approval roles. 'owner' (Derek) is the only role that can approve above 50%.
export const APPROVAL_PRESETS = {
  today: {
    label: 'Today: frontline up to reclean, refunds through Derek in #finance-refunds',
    max_rung: { frontline: 'L3', office_manager: 'L3', gm: 'L3', owner: 'L7' },
    refund_channel: '#finance-refunds',
  },
  target: {
    label: 'Target: Office Manager approves refunds up to 50%',
    max_rung: { frontline: 'L3', office_manager: 'L6', gm: 'L6', owner: 'L7' },
    refund_channel: '#finance-refunds',
  },
};

export const DEFAULT_SETTINGS = {
  approval_preset: 'today',
  max_rung: { ...APPROVAL_PRESETS.today.max_rung },
  // Role per staff login (users.email). Office Manager is a role, not a name.
  roles: {},
  hard_route_role: 'office_manager',
  credit_expiry_days: 90,
  // Automatic updates: daily, plus reading older months until this much history is stored.
  auto: { enabled: true, history_months: 12 },
  budget: {
    target_pct: null, // null = 20% below the historical average once the baseline is known
    below_average_by: 0.2,
    amber_at: 0.8,
    red_at: 1.0,
    alert_slack_user: null, // Derek's Slack user id for the red-alert DM
    qbo_tolerance: 0.02,
  },
  costs: {
    cleaner_hourly_default: 22,
    margin_per_hour_default: 18,
    travel_per_visit: 0,
    // Derek, Nov 28 2026: a reclean costs hours x the cleaner's wage, nothing else for now.
    // Switch these on to add travel or the lost slot's margin back.
    include_travel: false,
    include_lost_slot: false,
    reclean_default_hours: 2,
    reclean_spot_share: 0.5,
  },
  pilot_months: 6,
};

/** Roles can never approve past L7, and nobody but the owner can approve above L6 (50%). */
export function normalizeSettings(input = {}) {
  const s = structuredClone(DEFAULT_SETTINGS);
  const src = input || {};
  if (APPROVAL_PRESETS[src.approval_preset]) s.approval_preset = src.approval_preset;
  s.max_rung = { ...APPROVAL_PRESETS[s.approval_preset].max_rung, ...(src.max_rung || {}) };
  for (const [role, rung] of Object.entries(s.max_rung)) {
    if (!ORDER.includes(rung)) s.max_rung[role] = 'L0';
    if (role !== 'owner' && ORDER.indexOf(s.max_rung[role]) > ORDER.indexOf('L6')) s.max_rung[role] = 'L6';
  }
  s.max_rung.owner = 'L7';
  if (src.roles && typeof src.roles === 'object') for (const [email, role] of Object.entries(src.roles)) if (role in s.max_rung) s.roles[String(email).toLowerCase()] = role;
  if (['office_manager', 'gm', 'owner'].includes(src.hard_route_role)) s.hard_route_role = src.hard_route_role;
  const n = (v, lo, hi, d) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : d);
  s.credit_expiry_days = n(src.credit_expiry_days, 7, 730, s.credit_expiry_days);
  s.auto = { enabled: src.auto?.enabled !== false, history_months: n(src.auto?.history_months, 1, 12, 12) };
  s.pilot_months = n(src.pilot_months, 1, 24, s.pilot_months);
  const b = src.budget || {};
  s.budget.target_pct = b.target_pct == null ? null : n(b.target_pct, 0, 0.2, null);
  s.budget.alert_slack_user = typeof b.alert_slack_user === 'string' && /^[UW][A-Z0-9]{6,}$/.test(b.alert_slack_user) ? b.alert_slack_user : null;
  const c = src.costs || {};
  for (const k of Object.keys(s.costs)) s.costs[k] = n(c[k], 0, 500, s.costs[k]);
  s.costs.include_travel = c.include_travel === true;
  s.costs.include_lost_slot = c.include_lost_slot === true;
  s.costs.reclean_spot_share = n(c.reclean_spot_share, 0.1, 1, DEFAULT_SETTINGS.costs.reclean_spot_share);
  return s;
}

export const rungIndex = (rung) => ORDER.indexOf(rung);

/** Can this person approve this rung? Refund % above 50 always needs the owner. */
export function canApprove(settings, email, rung) {
  const role = settings.roles[String(email || '').toLowerCase()] || 'frontline';
  return rungIndex(rung) <= rungIndex(settings.max_rung[role] || 'L0');
}

/** The rung a historical refund maps onto (20% → L4, 30–40% → L5, 50% → L6, >50% → L7). */
export function rungForRefund(pct) {
  if (pct == null) return null;
  if (pct > 50) return 'L7';
  if (pct >= 45) return 'L6';
  if (pct >= 22.5) return 'L5';
  return 'L4';
}

/** Budget status: month-to-date cost as a share of month-to-date Residential revenue. */
export function budgetStatus({ cost, revenue }, settings, baselineAvg) {
  const target = settings.budget.target_pct ?? (baselineAvg != null ? Math.round(baselineAvg * (1 - settings.budget.below_average_by) * 10000) / 10000 : null);
  const rate = revenue > 0 ? cost / revenue : null;
  let level = 'unknown';
  if (rate != null && target) level = rate >= target * settings.budget.red_at ? 'red' : rate >= target * settings.budget.amber_at ? 'amber' : 'green';
  return { cost, revenue, rate, target, level };
}
