// Launch27's booking price calculation (same rules as web/src/lib/pricing.ts, which has
// the full explanation and is checked against real bookings). Used by the synthetic
// Launch27 so dev/QA bookings are priced exactly like production.
export const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function priceBooking({ services = [], frequency_percent = 0, code = null, adjustment = 0, tip = 0, giftcard = 0, tax_percent = 13 }) {
  let svc = 0;
  let params = 0;
  let extras = 0;
  let freqBase = 0;
  let codeBase = 0;
  for (const s of services) {
    const sp = s.hourly && s.hourlyRate ? r2(s.price * (s.hourly.minutes / 60) * (s.hourly.quantity || 1)) : r2(s.price || 0);
    const pp = (s.pricing_parameters || []).reduce((t, p) => t + r2(p.price * p.quantity), 0);
    svc += sp;
    params += pp;
    if (s.discount_by_frequency !== false) freqBase += sp + pp;
    if (s.discount_by_code !== false) codeBase += sp + pp;
    for (const x of s.extras || []) {
      const t = r2(x.price * x.quantity);
      extras += t;
      if (x.discount_by_frequency !== false) freqBase += t;
      if (x.discount_by_code !== false) codeBase += t;
    }
  }
  svc = r2(svc);
  params = r2(params);
  extras = r2(extras);
  const subtotal = r2(svc + params + extras);
  const frequency_discount = r2((freqBase * frequency_percent) / 100);
  const room = Math.max(0, r2(codeBase - frequency_discount));
  const code_discount = !code ? 0 : code.percent ? r2((room * code.percent) / 100) : r2(Math.min(code.amount || 0, room));
  const revenue = Math.max(0, r2(subtotal - frequency_discount - code_discount + (adjustment || 0)));
  const tax = r2((revenue * tax_percent) / 100);
  const total = Math.max(0, r2(revenue + tax + (tip || 0) - (giftcard || 0)));
  return { services: svc, pricing_parameters: params, extras, subtotal, frequency_discount, code_discount, adjustment: r2(adjustment || 0), revenue, tax, tip: r2(tip || 0), giftcard: r2(giftcard || 0), total };
}
