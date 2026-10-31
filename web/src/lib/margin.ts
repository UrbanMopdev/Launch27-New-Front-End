// Job profitability: gross margin per booking from Launch27 revenue and cleaner pay.
//
// Revenue   = booking summary.revenue (after discounts, before tax; tips excluded — they go to the cleaner)
// Labour    = Σ cleaner pay (teams[].earned = hourly rate × paid hours) × (1 + payroll on-costs)
// Other     = card processing (card-paid jobs) + supplies/travel per job
// Gross profit = Revenue − Labour − Other;  margin = GP / Revenue
// Client rate  = Revenue / paid cleaner-hours (and per actual hour worked, from check-in/out)

export interface CostSettings {
  onCostPct: number; // payroll on-costs on top of cleaner pay (CPP, EI, vacation, WSIB), %
  cardPct: number; // card processing, % of the charged total
  cardFixed: number; // card processing, $ per charge
  suppliesPerJob: number; // supplies, travel, etc., $ per job
  targetMarginPct: number; // jobs below this are flagged
  targetRate: number; // minimum revenue per paid cleaner-hour, $
}

export const DEFAULT_SETTINGS: CostSettings = { onCostPct: 0, cardPct: 2.9, cardFixed: 0.3, suppliesPerJob: 0, targetMarginPct: 40, targetRate: 40 };

export interface MarginInput {
  id: number;
  active?: boolean;
  service_date: string;
  user?: { id?: number; name?: string };
  services?: { name: string }[];
  frequency?: { name?: string };
  location?: { id?: number; name?: string };
  payment_method_info?: { code?: string; text?: string };
  summary?: { revenue?: number; total?: number; discount?: number; adjustment?: number; tip?: number };
  teams?: { id: number; title?: string; hours?: number; share?: number; earned?: number; time_tracking?: { checkin_at?: string | null; checkout_at?: string | null } | null }[];
  duration?: number; // booked minutes
}

/**
 * For a booking with no cleaner yet, a stand-in cleaner paid `payRate` for the booked
 * hours, so its margin can be forecast. The job is flagged as estimated.
 */
export function withEstimatedPay(job: MarginInput, payRate: number): MarginInput & { estimated: true } {
  const hours = job.duration ? job.duration / 60 : 0;
  return { ...job, estimated: true, teams: [{ id: 0, title: 'No cleaner yet', hours, share: payRate, earned: hours * payRate }] };
}

export type Flag = 'loss' | 'low_margin' | 'low_rate' | 'zero_revenue' | 'prepaid' | 'ran_over' | 'discounted' | 'no_pay' | 'estimated';

export const FLAG_LABEL: Record<Flag, string> = {
  loss: 'Losing money',
  low_margin: 'Low margin',
  low_rate: 'Low hourly rate',
  zero_revenue: '$0 revenue',
  prepaid: 'Prepaid plan visit',
  ran_over: 'Ran over time',
  discounted: 'Big discount / price cut',
  no_pay: 'No cleaner pay recorded',
  estimated: 'No cleaner yet (pay estimated)',
};

export interface JobMargin {
  job: MarginInput;
  revenue: number;
  labour: number;
  cardFee: number;
  supplies: number;
  profit: number;
  margin: number | null; // null when revenue is 0 or the visit is prepaid
  /** Left out of margin totals: $0 revenue, or a prepaid-plan visit whose revenue was collected up front. */
  excluded: boolean;
  paidHours: number;
  actualHours: number | null;
  ratePaid: number | null; // revenue per paid cleaner-hour
  rateActual: number | null; // revenue per actual hour worked
  payRate: number | null; // average cleaner $/h on the job
  flags: Flag[];
}

const isCard = (code = '') => code.startsWith('stripe') || code.startsWith('fspay');

export function jobMargin(job: MarginInput, s: CostSettings): JobMargin {
  const revenue = job.summary?.revenue || 0;
  const teams = job.teams || [];
  const pay = teams.reduce((sum, t) => sum + (t.earned ?? (t.share || 0) * (t.hours || 0)), 0);
  const labour = pay * (1 + s.onCostPct / 100);
  const charged = (job.summary?.total || 0) + (job.summary?.tip || 0);
  const cardFee = isCard(job.payment_method_info?.code) && charged > 0 ? (charged * s.cardPct) / 100 + s.cardFixed : 0;
  const supplies = revenue > 0 ? s.suppliesPerJob : 0;
  const profit = revenue - labour - cardFee - supplies;
  const paidHours = teams.reduce((sum, t) => sum + (t.hours || 0), 0);

  const tracked = teams.map((t) => t.time_tracking).filter((tt) => tt?.checkin_at && tt?.checkout_at);
  const actualHours = tracked.length && tracked.length === teams.length ? tracked.reduce((sum, tt) => sum + (Date.parse(tt!.checkout_at!) - Date.parse(tt!.checkin_at!)) / 3_600_000, 0) : null;

  // Prepaid plans are charged up front, so a visit's booking carries little or no revenue.
  const prepaid = /prepaid/i.test(job.frequency?.name || '');
  const excluded = revenue <= 0 || prepaid;
  const margin = excluded ? null : profit / revenue;
  const ratePaid = paidHours > 0 && !excluded ? revenue / paidHours : null;
  const rateActual = actualHours && actualHours > 0.25 && !excluded ? revenue / actualHours : null;
  const payRate = paidHours > 0 ? pay / paidHours : null;

  const flags: Flag[] = [];
  if (prepaid) flags.push('prepaid');
  else if (revenue <= 0) flags.push('zero_revenue');
  else {
    if (profit < 0) flags.push('loss');
    else if (margin !== null && margin < s.targetMarginPct / 100) flags.push('low_margin');
    if (ratePaid !== null && ratePaid < s.targetRate) flags.push('low_rate');
  }
  if (!pay && teams.length && !excluded) flags.push('no_pay');
  if ((job as { estimated?: boolean }).estimated) flags.push('estimated');
  if (actualHours !== null && paidHours > 0 && actualHours > paidHours + 0.5) flags.push('ran_over');
  const listPrice = revenue + (job.summary?.discount || 0) - Math.min(0, job.summary?.adjustment || 0);
  if (!excluded && listPrice > 0 && (listPrice - revenue) / listPrice >= 0.2) flags.push('discounted');

  return { job, revenue, labour, cardFee, supplies, profit, margin, excluded, paidHours, actualHours, ratePaid, rateActual, payRate, flags };
}

export interface Rollup {
  key: string;
  label: string;
  jobs: number;
  revenue: number;
  labour: number;
  profit: number;
  margin: number | null;
  paidHours: number;
  rate: number | null;
  flagged: number;
}

export function rollup(items: JobMargin[], keyOf: (m: JobMargin) => { key: string; label: string }[]): Rollup[] {
  const map = new Map<string, { label: string; list: JobMargin[] }>();
  for (const m of items) for (const k of keyOf(m)) {
    const g = map.get(k.key) || { label: k.label, list: [] };
    g.list.push(m);
    map.set(k.key, g);
  }
  return [...map.entries()].map(([key, { label, list }]) => summarise(list, key, label));
}

export function summarise(list: JobMargin[], key = 'all', label = 'All jobs'): Rollup {
  const priced = list.filter((m) => !m.excluded);
  const revenue = priced.reduce((s, m) => s + m.revenue, 0);
  const labour = priced.reduce((s, m) => s + m.labour, 0);
  const profit = priced.reduce((s, m) => s + m.profit, 0);
  const paidHours = priced.reduce((s, m) => s + m.paidHours, 0);
  return {
    key,
    label,
    jobs: list.length,
    revenue,
    labour,
    profit,
    margin: revenue > 0 ? profit / revenue : null,
    paidHours,
    rate: paidHours > 0 ? revenue / paidHours : null,
    flagged: list.filter(needsAttention).length,
  };
}

/** Losing money or below the target margin. */
export const needsAttention = (m: JobMargin) => m.flags.includes('loss') || m.flags.includes('low_margin');

/** Extra revenue needed to bring a job up to the target margin (0 if already there). */
export function marginGap(m: JobMargin, s: CostSettings): number {
  if (m.excluded) return 0;
  const target = s.targetMarginPct / 100;
  if (m.margin !== null && m.margin >= target) return 0;
  // Revenue R needed so that (R − costs) / R = target, with card fee scaling with price.
  const fixedCosts = m.labour + m.supplies + (m.cardFee > 0 ? s.cardFixed : 0);
  const varPct = m.cardFee > 0 ? s.cardPct / 100 : 0;
  const needed = fixedCosts / Math.max(0.01, 1 - target - varPct);
  return Math.max(0, needed - m.revenue);
}

const ANNUAL: [RegExp, number][] = [
  [/one time/i, 1],
  [/tri/i, 17],
  [/biweekly/i, 26],
  [/weekly/i, 52],
  [/monthly/i, 12],
];
export const visitsPerYear = (freq = '') => ANNUAL.find(([re]) => re.test(freq))?.[1] ?? 1;
