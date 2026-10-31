import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, jobMargin, marginGap, summarise, visitsPerYear, withEstimatedPay, type MarginInput } from './margin';

const job = (over: Partial<MarginInput> = {}): MarginInput => ({
  id: 1,
  service_date: '2026-10-20T13:00:00Z',
  payment_method_info: { code: 'check' },
  summary: { revenue: 150, total: 169.5, tip: 0, discount: 0, adjustment: 0 },
  teams: [{ id: 5, hours: 3, share: 22, earned: 66, time_tracking: { checkin_at: '2026-10-20T13:00:00Z', checkout_at: '2026-10-20T16:00:00Z' } }],
  ...over,
});
const s = { ...DEFAULT_SETTINGS, cardPct: 0, cardFixed: 0 };

describe('margin', () => {
  it('computes gross margin and client rate', () => {
    const m = jobMargin(job(), s);
    expect(m.labour).toBe(66);
    expect(m.profit).toBe(84);
    expect(m.margin).toBeCloseTo(0.56, 2);
    expect(m.ratePaid).toBe(50);
    expect(m.actualHours).toBe(3);
    expect(m.flags).toEqual([]);
  });

  it('applies payroll on-costs, card fees and supplies', () => {
    const m = jobMargin(job({ payment_method_info: { code: 'stripe' } }), { ...DEFAULT_SETTINGS, onCostPct: 10, suppliesPerJob: 5 });
    expect(m.labour).toBeCloseTo(72.6, 6);
    expect(m.cardFee).toBeCloseTo(169.5 * 0.029 + 0.3, 6);
    expect(m.profit).toBeCloseTo(150 - 72.6 - (169.5 * 0.029 + 0.3) - 5, 6);
  });

  it('flags low margin, low rate, losses, $0 jobs and overruns', () => {
    expect(jobMargin(job({ summary: { revenue: 100, total: 113 } }), s).flags).toEqual(['low_margin', 'low_rate']); // 34% margin, $33/h
    expect(jobMargin(job({ summary: { revenue: 50, total: 56.5 } }), s).flags).toContain('loss');
    expect(jobMargin(job({ summary: { revenue: 0, total: 0 } }), s).flags).toEqual(['zero_revenue']);
    const over = job({ teams: [{ id: 5, hours: 2, share: 22, earned: 44, time_tracking: { checkin_at: '2026-10-20T13:00:00Z', checkout_at: '2026-10-20T16:00:00Z' } }] });
    expect(jobMargin(over, s).flags).toContain('ran_over');
  });

  it('only counts actual hours when every cleaner checked in and out', () => {
    const m = jobMargin(job({ teams: [{ id: 5, hours: 2, earned: 44, time_tracking: null }, { id: 6, hours: 2, earned: 44, time_tracking: { checkin_at: '2026-10-20T13:00:00Z', checkout_at: '2026-10-20T15:00:00Z' } }] }), s);
    expect(m.actualHours).toBeNull();
    expect(m.paidHours).toBe(4);
  });

  it('works out the price increase needed to hit the target', () => {
    const m = jobMargin(job({ summary: { revenue: 100, total: 113 } }), s);
    const gap = marginGap(m, s);
    expect(gap).toBeCloseTo(66 / 0.6 - 100, 6); // need $110 to reach 40%
    expect(marginGap(jobMargin(job(), s), s)).toBe(0);
  });

  it('summarises with revenue-weighted margin and skips $0 jobs', () => {
    const items = [jobMargin(job(), s), jobMargin(job({ summary: { revenue: 0, total: 0 } }), s)];
    const r = summarise(items);
    expect(r.jobs).toBe(2);
    expect(r.revenue).toBe(150);
    expect(r.margin).toBeCloseTo(0.56, 2);
  });

  it('leaves prepaid-plan visits out of margin maths', () => {
    const m = jobMargin(job({ frequency: { name: 'Prepaid Biweekly' }, summary: { revenue: 15, total: 17 } }), s);
    expect(m.excluded).toBe(true);
    expect(m.margin).toBeNull();
    expect(m.flags).toEqual(['prepaid']);
    expect(marginGap(m, s)).toBe(0);
    expect(summarise([m, jobMargin(job(), s)]).revenue).toBe(150);
  });

  it('estimates pay for a job with no cleaner yet', () => {
    const m = jobMargin(withEstimatedPay(job({ teams: [], duration: 180 }), 22), s);
    expect(m.labour).toBe(66);
    expect(m.paidHours).toBe(3);
    expect(m.flags).toContain('estimated');
  });

  it('maps frequencies to visits per year', () => {
    expect(visitsPerYear('Biweekly - 10% off')).toBe(26);
    expect(visitsPerYear('Weekly - 15% off')).toBe(52);
    expect(visitsPerYear('Prepaid Monthly')).toBe(12);
    expect(visitsPerYear('One time')).toBe(1);
  });
});
