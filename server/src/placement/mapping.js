// Placement contract <-> Launch27: pure translations, no I/O.
// The contract (contracts/placement/openapi.yaml) is shared by every brand's front end; this
// file is where Launch27's services, frequencies, booking questions and locations are mapped
// onto it, and where a quote and a booking are turned into what Launch27 expects.
import { priceBooking, r2 } from '../mock/pricing.js';
import { frequencyKind, isPrepaid } from '../schedule/rules.js';

// Brand keys are shared with the Sales Hub and every other app, so they carry the company:
// this app's 'residential' brand is 'urbanmop-residential' to the hub.
export const BRAND_PREFIX = 'urbanmop-';
export const brandKey = (slug) => `${BRAND_PREFIX}${slug}`;
export const brandSlug = (key) => (String(key || '').startsWith(BRAND_PREFIX) ? String(key).slice(BRAND_PREFIX.length) : null);

// Which brand a Launch27 location belongs to when no admin has chosen (same rule as
// web/src/brands/rules.ts; admin choices in the brand_locations table win over this).
export function suggestBrand(name) {
  const n = String(name || '').toLowerCase();
  if (/commercial|cornwall/.test(n)) return 'commercial';
  if (/ottawa|kitchener|waterloo|carpet/.test(n)) return 'residential';
  return null;
}

// Launch27 frequency -> contract frequency. Every-3-weeks has no contract value yet.
const KIND_TO_CONTRACT = { one: 'one_time', weekly: 'weekly', bi: 'biweekly', monthly: 'every_4_weeks' };
export const CONTRACT_TO_KIND = Object.fromEntries(Object.entries(KIND_TO_CONTRACT).map(([k, v]) => [v, k]));

/** contract frequency -> the Launch27 frequency to book with (first one that isn't prepaid). */
export function frequencyMap(l27Frequencies = []) {
  const out = new Map();
  for (const f of l27Frequencies) {
    if (f.active === false || isPrepaid(f.name)) continue;
    const c = KIND_TO_CONTRACT[frequencyKind(f.name)];
    if (c && !out.has(c)) out.set(c, f);
  }
  return out;
}

// Pricing parameters are matched to the contract's home details by name.
const HOME_FIELDS = [
  ['half_bathrooms', /half\s*bath/i],
  ['bathrooms', /bath/i],
  ['bedrooms', /bed/i],
  ['square_feet', /sq(uare)?\.?\s*f(ee)?t/i],
];
export const homeKeyOf = (paramName) => HOME_FIELDS.find(([, re]) => re.test(String(paramName || '')))?.[0] || null;

/**
 * Services the hub may quote: priced ones whose pricing parameters all map to home details.
 * (Commercial and internal services, priced at $0, are quoted by people, not here.)
 */
export function quotableServices(l27Services = []) {
  return l27Services.filter((s) => s.active !== false && Number(s.price) > 0 && (s.pricing_parameters || []).every((p) => homeKeyOf(p.name)));
}

export function catalogService(s) {
  const out = {
    code: String(s.id),
    name: s.name,
    home_fields: (s.pricing_parameters || []).map((p) => ({
      key: homeKeyOf(p.name),
      label: p.name,
      required: Number(p.quantity_minimum) > 0,
      ...(p.quantity_minimum != null ? { min: Number(p.quantity_minimum) } : {}),
      ...(p.quantity_maximum != null ? { max: Number(p.quantity_maximum) } : {}),
    })),
    extras: (s.extras || []).filter((x) => x.active !== false).map((x) => ({ code: String(x.id), name: x.name, max_quantity: x.quantity_based ? Math.max(1, Number(x.quantity_maximum) || 10) : 1 })),
  };
  if (s.hourly) {
    out.hourly = { min_minutes: Number(s.hourly.minutes_minimum) || 60, max_minutes: Number(s.hourly.minutes_maximum) || 720, step_minutes: s.hourly.half_hour_increments ? 30 : 60 };
  }
  return out;
}

// ---------- booking questions (Launch27 custom fields) ----------
const stripTags = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const firstHref = (html) => String(html || '').match(/href="(https?:[^"]+)"/i)?.[1] || null;

/** Launch27 custom fields -> contract questions. Unlabelled and inactive fields are skipped. */
export function questionsOf(fields = []) {
  const out = [];
  for (const f of fields) {
    const label = stripTags(f.label);
    if (f.active === false || !label) continue;
    const type = f.control_type === 'checkbox' ? 'checkbox' : f.control_type === 'checkbox_list' ? 'multi_choice' : (f.options || []).length ? 'single_choice' : 'text';
    const q = { id: String(f.id), label, type, required: !!f.value_required };
    const url = firstHref(f.label);
    if (url) q.url = url;
    if (type === 'single_choice' || type === 'multi_choice') q.options = f.options.filter((o) => o.active !== false).map((o) => ({ id: String(o.id), label: stripTags(o.label) }));
    out.push(q);
  }
  return out;
}

/**
 * Contract answers -> Launch27 custom_fields. Returns the ids of required questions that are
 * missing or invalid (a required checkbox must be true).
 */
export function customFieldsFrom(fields = [], answers = []) {
  const byId = new Map(answers.map((a) => [String(a.question_id), a]));
  const custom_fields = [];
  const missing = [];
  for (const q of questionsOf(fields)) {
    const a = byId.get(q.id);
    let entry = null;
    if (a) {
      if (q.type === 'checkbox' && typeof a.value === 'boolean') entry = { id: Number(q.id), value: String(a.value) };
      else if (q.type === 'text' && typeof a.value === 'string' && a.value.trim()) entry = { id: Number(q.id), value: a.value.trim() };
      else if (q.options) {
        const valid = new Set(q.options.map((o) => o.id));
        const ids = (a.option_ids || []).filter((id) => valid.has(String(id)));
        const ok = q.type === 'single_choice' ? ids.length === 1 : ids.length > 0;
        if (ok && ids.length === (a.option_ids || []).length) entry = { id: Number(q.id), values: ids.map((id) => ({ id: Number(id), other: null })) };
      }
    }
    const accepted = entry && !(q.type === 'checkbox' && q.required && entry.value !== 'true');
    if (accepted) custom_fields.push(entry);
    else if (q.required) missing.push(q.id);
  }
  return { custom_fields, missing };
}

// ---------- locations ----------
/**
 * The Launch27 location a postal code belongs to, within one brand. Longest postcode prefix
 * wins; ties go to Launch27's default location, then the lowest id.
 * brandOf(location) -> brand slug or null.
 */
export function locationFor(locations = [], postalCode, slug, brandOf) {
  const pc = String(postalCode || '').toUpperCase().replace(/\s+/g, '');
  let best = null;
  for (const l of locations) {
    if (l.active === false || brandOf(l) !== slug) continue;
    const len = Math.max(0, ...(l.postcodes || []).map((p) => String(p).toUpperCase().replace(/\s+/g, '')).filter((p) => p && pc.startsWith(p)).map((p) => p.length));
    if (!len) continue;
    const better = !best || len > best.len || (len === best.len && (Number(!!l.default) > Number(!!best.l.default) || (!!l.default === !!best.l.default && l.id < best.l.id)));
    if (better) best = { l, len };
  }
  return best?.l || null;
}

/** Sales tax % for a location: the latest rate already in effect that lists it. */
export function taxPercentFor(salesTaxes = [], locationId, today) {
  const rows = salesTaxes.filter((t) => (!t.locations?.length || t.locations.some((l) => Number(l.id) === Number(locationId))) && (!t.effective_date || String(t.effective_date).slice(0, 10) <= today));
  rows.sort((a, b) => String(b.effective_date || '').localeCompare(String(a.effective_date || '')));
  return rows.length ? Number(rows[0].percent) || 0 : 13;
}

// ---------- quote ----------
const money = (dollars) => ({ amount_cents: Math.round(r2(dollars) * 100), currency: 'CAD' });

/**
 * Prices a QuoteRequest against one Launch27 service. Throws { code: 'invalid_request' } when
 * the request doesn't fit the service (unknown extra, missing hours...).
 * Returns the contract price and duration, plus the Launch27 service line to book with.
 */
export function priceQuote({ service, request, frequency, recurringFrequency = null, taxPercent }) {
  const bad = (message) => Object.assign(new Error(message), { code: 'invalid_request' });
  const home = request.home || {};
  const pricing_parameters = (service.pricing_parameters || []).map((p) => {
    const key = homeKeyOf(p.name);
    const q = home[key];
    const min = Number(p.quantity_minimum) || 0;
    const max = p.quantity_maximum != null ? Number(p.quantity_maximum) : Infinity;
    const quantity = q == null ? min : Number(q);
    if (!Number.isInteger(quantity) || quantity < min || quantity > max) throw bad(`${p.name} must be a whole number from ${min}${Number.isFinite(max) ? ` to ${max}` : ''}.`);
    return { id: p.id, name: p.name, price: Number(p.price) || 0, quantity };
  });
  const extras = (request.extras || []).map((x) => {
    const def = (service.extras || []).find((e) => String(e.id) === String(x.code) && e.active !== false);
    if (!def) throw bad(`Extra ${x.code} isn't offered with ${service.name}.`);
    const max = def.quantity_based ? Math.max(1, Number(def.quantity_maximum) || 10) : 1;
    if (x.quantity > max) throw bad(`${def.name}: at most ${max}.`);
    return { def, quantity: x.quantity };
  });
  let hourly = null;
  if (service.hourly) {
    const h = service.hourly;
    const minutes = Number(request.minutes);
    const step = h.half_hour_increments ? 30 : 60;
    if (!minutes) throw bad(`${service.name} is sold by time: send minutes.`);
    if (minutes < h.minutes_minimum || minutes > h.minutes_maximum || minutes % step) throw bad(`${service.name}: minutes must be ${h.minutes_minimum}–${h.minutes_maximum} in steps of ${step}.`);
    hourly = { quantity: Number(h.quantity_minimum) || 1, minutes };
  }

  const priceFor = (freq) =>
    priceBooking({
      services: [{
        price: Number(service.price) || 0,
        hourly: hourly ? { minutes: hourly.minutes, quantity: hourly.quantity } : null,
        hourlyRate: !!hourly,
        discount_by_frequency: service.discount_by_frequency,
        discount_by_code: service.discount_by_code,
        pricing_parameters: pricing_parameters.map((p) => ({ price: p.price, quantity: p.quantity })),
        // Recurring visits only repeat extras marked recurring.
        extras: extras.filter((x) => freq.first || x.def.recurring).map((x) => ({ price: Number(x.def.price) || 0, quantity: x.quantity, discount_by_frequency: x.def.discount_by_frequency, discount_by_code: x.def.discount_by_code })),
      }],
      frequency_percent: Number(freq.f?.percent) || 0,
      tax_percent: taxPercent,
    });
  const first = priceFor({ f: frequency, first: true });
  const lines = [];
  const servicePrice = hourly ? r2(Number(service.price) * (hourly.minutes / 60) * hourly.quantity) : Number(service.price) || 0;
  lines.push({ label: hourly ? `${service.name}, ${hourly.minutes / 60} h` : service.name, amount: money(servicePrice) });
  for (const p of pricing_parameters) if (p.quantity && p.price) lines.push({ label: `${p.name} × ${p.quantity}`, amount: money(p.price * p.quantity) });
  for (const x of extras) lines.push({ label: x.quantity > 1 ? `${x.def.name} × ${x.quantity}` : x.def.name, amount: money(Number(x.def.price) * x.quantity) });
  if (first.frequency_discount) lines.push({ label: `${frequency.name} discount`, amount: money(-first.frequency_discount) });
  lines.push({ label: `Tax (${taxPercent}%)`, amount: money(first.tax) });

  const price = { first_visit: money(first.total), lines, taxes_included: true };
  if (recurringFrequency) price.recurring_visit = money(priceFor({ f: recurringFrequency, first: false }).total);

  const duration = hourly ? hourly.minutes : (Number(service.duration) || 180) + extras.reduce((t, x) => t + (Number(x.def.duration) || 0) * x.quantity, 0);
  const line = { id: service.id };
  if (hourly) line.hourly = hourly;
  if ((service.pricing_parameters || []).length) line.pricing_parameters = pricing_parameters.map((p) => ({ id: p.id, quantity: p.quantity }));
  if (extras.length) line.extras = extras.map((x) => ({ id: x.def.id, quantity: x.quantity, recurring: null }));
  return { price, duration_minutes: duration, l27_line: line };
}

// ---------- booking ----------
const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** The POST /v1/staff/bookings body, built the same way as the app's booking form. */
export function bookingBody({ quote, slot, customer, existingCustomerId = null, customFields, paymentMethod, staffNotes }) {
  const addr = customer.address || quote.address;
  return {
    user: existingCustomerId ? { id: existingCustomerId } : { first_name: customer.first_name, last_name: customer.last_name || null, email: customer.email || null },
    address: [addr.line1, addr.line2].filter(Boolean).join(', '),
    city: addr.city,
    state: addr.region,
    zip: addr.postal_code,
    phone: customer.phone,
    location_id: quote.location_id,
    frequency_id: quote.frequency_id,
    service_date: `${slot.date}T${hm(slot.start)}:00`,
    arrival_window: slot.arrival_window,
    services: [quote.l27_line],
    discount_code: null,
    tip: null,
    tip_recurring: false,
    payment_method: paymentMethod,
    customer_notes: null,
    staff_notes: staffNotes,
    custom_fields: customFields,
    teams: [slot.cleaner_id],
    sms_notifications: false,
  };
}

/** Staff notes for a booking made through placement: the customer's notes, then where it came from. */
export function staffNotesFor({ accessNotes, placedBy, caller, leadRef, source }) {
  const who = placedBy.display_name ? `${placedBy.display_name} (${placedBy.kind} ${placedBy.id})` : `${placedBy.kind} ${placedBy.id}`;
  const from = [source?.channel, source?.campaign].filter(Boolean).join(' / ');
  return [accessNotes?.trim() || null, `Booked through ${caller} by ${who}${leadRef ? `, lead ${leadRef}` : ''}${from ? `, source ${from}` : ''}.`].filter(Boolean).join('\n\n');
}
