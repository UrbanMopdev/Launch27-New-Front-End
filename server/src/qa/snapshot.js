// Builds the anonymized QA copy from live Launch27 (run in production only).
// get(path, query) fetches from Launch27 with the signed-in admin's token.
import { assertAnonymous, createAnonymizer, personTokens, sensitiveStrings } from './anonymize.js';

const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

async function all(get, path, query = {}, max = 200) {
  const out = [];
  for (let page = 0; page < max; page++) {
    const rows = await get(path, { ...query, limit: 100, offset: page * 100 });
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

export async function buildSnapshot(get, { now = Date.now(), daysBack = 60, daysAhead = 60, log = () => {}, check = true } = {}) {
  const from = iso(now - daysBack * DAY);
  const to = iso(now + daysAhead * DAY);
  log('pulling bookings', { from, to });
  const active = await all(get, '/v1/staff/bookings', { from, to });
  const cancelled = await all(get, '/v1/staff/bookings', { from, to, filter: 'cancelled' });
  // Ratings only come back when asked for; merge them onto the bookings.
  const rated = await all(get, '/v1/staff/bookings', { from, to, options: 'with_feedback' });
  const feedback = new Map(rated.filter((b) => b.feedback).map((b) => [b.id, b.feedback]));
  const byId = new Map();
  for (const b of [...active, ...cancelled]) byId.set(b.id, { ...b, feedback: b.feedback || feedback.get(b.id) || null });
  const bookings = [...byId.values()];

  log('pulling customers and cleaners');
  const customers = await all(get, '/v1/staff/customers', {}, 300);
  const teams = await all(get, '/v1/staff/teams', {});
  const locations = await get('/v1/staff/locations', { limit: 100 });
  const services = {};
  const frequencies = {};
  for (const l of Array.isArray(locations) ? locations : []) {
    if (l.active === false) continue;
    services[l.id] = await get('/v1/booking/services', { location_id: l.id });
    frequencies[l.id] = await get('/v1/booking/frequencies', { location_id: l.id });
  }
  const staffFrequencies = await get('/v1/staff/frequencies', { limit: 100 });
  const customFields = await get('/v1/staff/booking_form/custom_fields', {});
  const salesTaxes = await get('/v1/staff/sales_taxes', {});

  // Cards for customers with bookings in the window (brand and expiry only).
  const withBookings = [...new Set(bookings.map((b) => b.user?.id).filter(Boolean))];
  const billing = {};
  for (const id of withBookings) {
    try {
      billing[id] = await get(`/v1/staff/customers/${id}/setup/billing`, {});
    } catch {
      billing[id] = null;
    }
  }

  log('anonymizing', { bookings: bookings.length, customers: customers.length, teams: teams.length });
  const a = createAnonymizer(undefined, personTokens({ customers, teams }));
  const copy = {
    version: 1,
    created_at: new Date(now).toISOString(),
    window: { from, to },
    customers: customers.map(a.customer),
    teams: teams.map(a.team),
    bookings: bookings.map(a.booking),
    cards: Object.fromEntries(Object.entries(billing).map(([id, b]) => [id, a.cards(b)])),
    locations: (Array.isArray(locations) ? locations : []).map((l) => ({ id: l.id, name: l.name, active: l.active, default: l.default })),
    services,
    frequencies,
    staff_frequencies: Array.isArray(staffFrequencies) ? staffFrequencies.map((f) => ({ id: f.id, name: f.name, interval: f.interval, percent: f.percent, amount: f.amount, active: f.active })) : [],
    custom_fields: Array.isArray(customFields) ? customFields : [],
    sales_taxes: Array.isArray(salesTaxes) ? salesTaxes.map((t) => ({ id: t.id, effective_date: t.effective_date, percent: t.percent, locations: (t.locations || []).map((l) => ({ id: l.id, name: l.name })) })) : [],
  };
  // Configuration can also hold text typed by staff; scrub any help text.
  for (const f of copy.custom_fields) delete f.help_text;
  const originals = sensitiveStrings({ customers, teams, bookings });
  // Cities and location names are kept on purpose; some records hold a city in the street
  // field, which would otherwise look like a leak.
  const places = [...copy.customers, ...copy.teams].map((x) => x.city).concat(copy.bookings.map((b) => b.address?.city), copy.locations.map((l) => l.name));
  for (const p of places) if (p) originals.delete(String(p).trim().toLowerCase());
  if (!check) return { copy, originals }; // tests and diagnostics only
  assertAnonymous(copy, originals);
  return copy;
}

export function summarize(copy) {
  return { created_at: copy.created_at, window: copy.window, bookings: copy.bookings.length, customers: copy.customers.length, cleaners: copy.teams.length };
}
