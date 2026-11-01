// How Launch27 adds up a booking, reverse-engineered from real bookings and checked
// against every one of 3,439 (Sep–Nov 2026) to the cent (see pricing.fixtures.json):
//
//   1. Line items: service price (hourly: rate × hours × cleaners), each room/pricing
//      parameter price × quantity, each extra price × quantity.
//   2. Frequency discount: frequency % of the items that allow it (the service and its
//      rooms follow the service's flag; each extra has its own flag, e.g. Move In Move
//      Out never gets it). Rounded to the cent.
//   3. Discount code: applied after the frequency discount, on the items that allow
//      codes: a % of (code-eligible items − frequency discount), or a fixed amount
//      (never more than that). Rounded to the cent.
//   4. Price adjustment (+/−) is added before tax.
//   5. Before tax ("revenue") never goes below $0.
//   6. Tax (13% HST in Ontario) on the before-tax amount, rounded to the cent.
//   7. Tip is added after tax and is not taxed.
//   8. Gift card comes off last; the total never goes below $0.

export interface PriceItem {
  price: number;
  quantity: number;
  discount_by_frequency?: boolean;
  discount_by_code?: boolean;
}

export interface PriceService {
  price: number; // flat price, or the hourly rate when `hourly` is set
  hourly?: { minutes: number; quantity: number } | null;
  hourlyRate?: boolean; // true: `price` is a per-hour rate to multiply out (form); false/absent: already multiplied (Launch27 booking)
  discount_by_frequency?: boolean;
  discount_by_code?: boolean;
  pricing_parameters?: { price: number; quantity: number }[];
  extras?: PriceItem[];
}

export interface PriceInput {
  services: PriceService[];
  frequency_percent?: number;
  code?: { percent?: number; amount?: number } | null;
  adjustment?: number;
  tip?: number;
  giftcard?: number;
  tax_percent?: number;
}

export interface PriceBreakdown {
  services: number;
  pricing_parameters: number;
  extras: number;
  subtotal: number;
  frequency_discount: number;
  code_discount: number;
  adjustment: number;
  revenue: number; // before tax
  tax: number;
  tip: number;
  giftcard: number;
  total: number;
}

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function servicePrice(s: PriceService) {
  if (s.hourly && s.hourlyRate) return r2(s.price * (s.hourly.minutes / 60) * (s.hourly.quantity || 1));
  return r2(s.price || 0);
}

export function priceBooking(input: PriceInput): PriceBreakdown {
  let services = 0;
  let params = 0;
  let extras = 0;
  let freqBase = 0;
  let codeBase = 0;
  for (const s of input.services) {
    const sp = servicePrice(s);
    const pp = (s.pricing_parameters || []).reduce((t, p) => t + r2(p.price * p.quantity), 0);
    services += sp;
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
  services = r2(services);
  params = r2(params);
  extras = r2(extras);
  const subtotal = r2(services + params + extras);
  const frequency_discount = r2((freqBase * (input.frequency_percent || 0)) / 100);
  const codeRoom = Math.max(0, r2(codeBase - frequency_discount));
  const code = input.code;
  const code_discount = !code ? 0 : code.percent ? r2((codeRoom * code.percent) / 100) : r2(Math.min(code.amount || 0, codeRoom));
  const adjustment = r2(input.adjustment || 0);
  const revenue = Math.max(0, r2(subtotal - frequency_discount - code_discount + adjustment));
  const tax = r2((revenue * (input.tax_percent ?? 13)) / 100);
  const tip = r2(input.tip || 0);
  const giftcard = r2(input.giftcard || 0);
  const total = Math.max(0, r2(revenue + tax + tip - giftcard));
  return { services, pricing_parameters: params, extras, subtotal, frequency_discount, code_discount, adjustment, revenue, tax, tip, giftcard, total };
}
