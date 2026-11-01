import { describe, expect, it } from 'vitest';
import fixtures from './pricing.fixtures.json';
import { priceBooking, type PriceInput } from './pricing';

// Each case is a real Launch27 booking (anonymized to numbers and flags). Our calculation
// must give exactly what Launch27 charged.
describe('pricing matches Launch27 to the cent', () => {
  for (const [i, c] of fixtures.cases.entries()) {
    it(`#${i + 1} ${c.scenario}`, () => {
      const got = priceBooking(c.input as PriceInput);
      const e = c.expected;
      expect(got.services).toBeCloseTo(e.services, 2);
      expect(got.pricing_parameters).toBeCloseTo(e.pricing_parameters, 2);
      expect(got.extras).toBeCloseTo(e.extras, 2);
      expect(got.frequency_discount).toBeCloseTo(e.frequency_discount, 2);
      expect(got.code_discount).toBeCloseTo(e.code_discount, 2);
      expect(got.revenue).toBeCloseTo(e.revenue, 2);
      expect(got.tax).toBeCloseTo(e.tax, 2);
      expect(got.total).toBeCloseTo(e.total, 2);
    });
  }

  it('covers every scenario we found', () => {
    const tags = new Set(fixtures.cases.flatMap((c) => c.scenario.split(', ')));
    for (const t of ['one-time', 'recurring 5%', 'recurring 10%', 'recurring 15%', 'prepaid', 'code %', 'code $', 'gift card', 'adjustment +', 'adjustment -', 'floored at $0', 'tip', 'hourly', 'extra without frequency discount', 'quantity extra', 'service without frequency discount']) {
      expect(tags.has(t), t).toBe(true);
    }
  });

  it('hourly rate in the form is rate × hours × cleaners', () => {
    const got = priceBooking({ services: [{ price: 55, hourlyRate: true, hourly: { minutes: 210, quantity: 2 } }], tax_percent: 13 });
    expect(got.services).toBe(385);
    expect(got.total).toBe(435.05);
  });

  it('a code comes off after the frequency discount; fixed codes never exceed what is left', () => {
    const base = { services: [{ price: 212.33 }], frequency_percent: 10, tax_percent: 13 };
    expect(priceBooking({ ...base, code: { percent: 10 } }).code_discount).toBe(19.11);
    expect(priceBooking({ ...base, code: { amount: 500 } }).code_discount).toBe(191.1);
  });
});
