// Synthetic, in-process stand-in for the Launch27 API (L27_MODE=mock).
//
// Development and QA run against this instead of the real tenant: Launch27 holds real
// customer data and has no test tenant, and live writes notify real customers. Data is
// generated deterministically (same day → same bookings), uses example.com emails and
// 555 phone numbers, and covers the endpoints the app uses. Writes (assign, cancel,
// restore, edit, create) apply to an in-memory overlay, so editing flows can be tested
// end to end; the overlay resets when the process restarts.
//
// Usage: createApp(config, { fetchImpl: createMockLaunch27({ password }) })

const FIRST = ['Avery', 'Jordan', 'Taylor', 'Morgan', 'Riley', 'Casey', 'Quinn', 'Jamie', 'Drew', 'Reese', 'Skyler', 'Rowan', 'Emerson', 'Hayden', 'Parker', 'Sage', 'Logan', 'Blake', 'Cameron', 'Dakota'];
const LAST = ['Tremblay', 'Martin', 'Roy', 'Gagnon', 'Lee', 'Wilson', 'Johnson', 'MacDonald', 'Taylor', 'Campbell', 'Anderson', 'Smith', 'Brown', 'Leblanc', 'Clark', 'Young', 'Wright', 'Scott', 'Morin', 'Fortin'];
const STREETS = ['Bank St', 'Elgin St', 'Somerset St W', 'Carling Ave', 'Bronson Ave', 'Rideau St', 'Main St', 'Richmond Rd', 'Wellington St W', 'Montreal Rd', 'Merivale Rd', 'Baseline Rd'];
const COMMENTS_GOOD = ['Great job, thank you!', 'Spotless as always.', 'Very friendly and thorough.', 'Kitchen looks amazing.', 'Always on time, thanks.'];
const COMMENTS_BAD = ['Missed the baseboards and the kitchen floor.', 'Arrived late and seemed rushed.', 'Bathroom still had streaks.', 'Not as thorough as last time.'];

const LOCATIONS = [
  { id: 1, name: 'Ottawa', active: true, default: true, postcodes: ['K1A'], booking_spots_mode: 'flexible', counts: {} },
  { id: 167, name: 'Commercial Ottawa', active: true, default: false, postcodes: ['K1A'], booking_spots_mode: 'flexible', counts: {} },
];
const SERVICES = [
  { id: 1180, name: 'One Bedroom Home', price: 137.5, duration: 150 },
  { id: 1181, name: 'Two Bedroom Home', price: 137.5, duration: 180 },
  { id: 1182, name: 'Three Bedroom Home', price: 151.25, duration: 210 },
  { id: 1186, name: 'Hourly Cleaning', price: 55, duration: 180 },
  { id: 21, name: 'Commercial', price: 120, duration: 120 },
];
const EXTRAS = [
  { id: 225, name: 'Spot Clean Walls', price: 55, quantity_based: false },
  { id: 226, name: 'Inside Oven', price: 35, quantity_based: false },
  { id: 227, name: 'Deep Cleaning', price: 60, quantity_based: false },
  { id: 228, name: 'Inside Fridge', price: 35, quantity_based: false },
];
const FREQUENCIES = [
  { id: 171, name: 'One time', interval: 'o', percent: 0 },
  { id: 12, name: 'Biweekly - 10% off', interval: 'b', percent: 10 },
  { id: 73, name: 'Monthly - 5% off', interval: 'm', percent: 5 },
  { id: 74, name: 'Weekly - 15% off', interval: 'w', percent: 15 },
];
const COLORS = ['#ffb8b8', '#b8d8ff', '#c8f0c0', '#ffe2a8', '#e0c8ff', '#a8ece6', '#ffd0e8', '#d6d6d6'];

// Small deterministic PRNG so the same seed always gives the same data.
function rng(seed) {
  let s = seed % 2147483647 || 1;
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return { next, int: (n) => Math.floor(next() * n), pick: (arr) => arr[Math.floor(next() * arr.length)] };
}
const hash = (str) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const iso = (d) => d.toISOString().replace('.000Z', 'Z');
const DAY0 = Date.UTC(2020, 0, 1);
// Launch27 takes service_date as local (Toronto) wall-clock time and returns UTC.
export function torontoToUtc(local) {
  if (!local) return new Date().toISOString();
  const guess = new Date(`${String(local).slice(0, 19)}Z`);
  const asToronto = new Date(guess.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (asUtc - asToronto)).toISOString().replace('.000Z', 'Z');
}
const dayIndex = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - DAY0) / 86_400_000);
const dateOf = (index) => new Date(DAY0 + index * 86_400_000).toISOString().slice(0, 10);

function buildTeams() {
  const r = rng(42);
  return Array.from({ length: 14 }, (_, i) => {
    const first = FIRST[(i * 3) % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    return {
      id: 9000 + i,
      title: `${first} ${last}`,
      first_name: first,
      last_name: last,
      email: `cleaner${i + 1}@example.com`,
      phone: `(613) 555-02${String(i).padStart(2, '0')}`,
      address: `${100 + i * 7} ${r.pick(STREETS)}`,
      city: 'Ottawa',
      state: 'ON',
      zip: 'K1A 0A1',
      latitude: 45.35 + r.next() * 0.15,
      longitude: -75.8 + r.next() * 0.2,
      notes: '',
      rating: 0,
      stars: 4 + Math.round(r.next() * 10) / 10,
      ratings_count: 5 + r.int(40),
      fg_color: '#000000',
      bg_color: COLORS[i % COLORS.length],
      active: true,
      confirmed: true,
      share: [20, 21, 22, 22, 22, 23, 24][i % 7],
      tags_info: [],
      locations: [i < 11 ? LOCATIONS[0] : LOCATIONS[1]].map(({ id, name }) => ({ id, name, active: true, default: id === 1 })),
    };
  });
}

function buildCustomers() {
  const r = rng(7);
  return Array.from({ length: 80 }, (_, i) => {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 3 + 1) % LAST.length];
    return {
      id: 50000 + i,
      company_name: i % 13 === 0 ? `${last} Property Group` : null,
      first_name: first,
      last_name: last,
      email: `customer${i + 1}@example.com`,
      has_generated_email: false,
      phone: `(613) 555-01${String(i % 100).padStart(2, '0')}`,
      address: `${10 + i * 3} ${r.pick(STREETS)}`,
      city: r.pick(['Ottawa', 'Ottawa', 'Nepean', 'Gloucester', 'Kanata']),
      state: 'ON',
      zip: 'K1A 0A1',
      latitude: 45.3 + r.next() * 0.2,
      longitude: -75.85 + r.next() * 0.3,
      notes: i % 9 === 0 ? 'Prefers the same cleaner each visit.' : null,
      referral_code: `REF${1000 + i}`,
      active: true,
      confirmed: true,
      is_new_customer: i % 17 === 0,
      created_at: iso(new Date(DAY0 - (400 - i * 4) * 86_400_000)),
      tags_info: i % 11 === 0 ? [{ id: 1, name: 'VIP', type: 'regular', color: null }] : null,
      frequency: FREQUENCIES[i % FREQUENCIES.length],
      location: i % 10 === 9 ? LOCATIONS[1] : LOCATIONS[0],
    };
  });
}

export function createMockLaunch27({ password = 'demo', now = () => Date.now() } = {}) {
  const teams = buildTeams();
  const customers = buildCustomers();
  const overlay = new Map(); // booking id -> partial changes
  const created = new Map(); // booking id -> booking created through the API
  let nextId = 900_000;

  function bookingsForDay(date) {
    const idx = dayIndex(date);
    const r = rng(hash(date));
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const count = weekday === 0 ? 0 : weekday === 6 ? 4 + r.int(3) : 11 + r.int(6);
    const list = [];
    for (let i = 0; i < count; i++) list.push(makeBooking(idx * 100 + i, date, r));
    for (const b of created.values()) if (b.service_date.slice(0, 10) === date) list.push(b);
    return list.map(applyOverlay);
  }

  function makeBooking(id, date, r) {
    const c = customers[(id * 7 + 3) % customers.length];
    const svc = c.location.id === 167 ? SERVICES[4] : SERVICES[r.int(4)];
    const hour = [8, 8, 9, 9, 10, 12, 13, 13, 14][r.int(9)];
    const start = new Date(`${date}T${String(hour + 5).padStart(2, '0')}:00:00Z`); // ~EST
    const extras = r.next() < 0.2 ? [{ ...r.pick(EXTRAS), quantity: 1 }] : [];
    const baths = 1 + r.int(3);
    const pp = [
      { id: 137, type: 'flat', name: 'Full Bathrooms', price: 27.5, quantity: baths, total: 27.5 * baths },
      { id: 138, type: 'flat', name: 'Half Bathrooms', price: 18.33, quantity: 0, total: 0 },
    ];
    const subtotal = svc.price + pp.reduce((s, p) => s + p.total, 0) + extras.reduce((s, x) => s + x.price, 0);
    const discount = Math.round(subtotal * (c.frequency.percent / 100) * 100) / 100;
    const revenue = Math.round((subtotal - discount) * 100) / 100;
    const tax = Math.round(revenue * 0.13 * 100) / 100;
    const duration = svc.duration + (baths - 1) * 30 + extras.length * 60;
    const unassigned = r.next() < 0.08;
    const team = teams.filter((t) => t.locations[0].id === c.location.id)[r.int(c.location.id === 167 ? 3 : 11)];
    const hours = Math.round((duration / 60) * 100) / 100;
    const past = start.getTime() + duration * 60_000 < now();
    const late = r.next() < 0.1 ? 25 : 0;
    const checkin = new Date(start.getTime() + (5 + r.int(20) + late) * 60_000);
    const checkout = new Date(checkin.getTime() + duration * 60_000 * (0.85 + r.next() * 0.3));
    const tracking = !unassigned && (past || checkin.getTime() < now())
      ? [{ id: id * 10, booking_id: id, team: { id: team.id, title: team.title, image: null }, state: 'draft', enroute_started_at: null, enroute_finished_at: null, checkin_at: iso(checkin), checkin_latitude: c.latitude, checkin_longitude: c.longitude, checkout_at: past ? iso(checkout) : null, distance: null, active: true }]
      : [];
    const rated = past && r.next() < 0.15;
    const rating = r.next() < 0.78 ? 2 : r.next() < 0.5 ? 1 : 0;
    const card = r.next() < 0.75;
    const charged = past && card ? [{ id: id * 10 + 1, amount: revenue + tax, status: 'succeeded', charged_date: iso(checkout), description: `UrbanMop - ${date}`, payment_method_info: { code: 'stripe', text: 'visa - 4242' } }] : [];
    return {
      id,
      digest: `mock${id}`,
      location: { id: c.location.id, name: c.location.name, active: true, default: c.location.id === 1, postcodes: [] },
      location_id: c.location.id,
      user: { id: c.id, name: `${c.first_name} ${c.last_name}`, email: c.email, first_name: c.first_name, last_name: c.last_name, is_new_customer: c.is_new_customer },
      service_date: iso(start),
      arrival_window: 60,
      address: { full_address: `${c.address}, ${c.city}, ON ${c.zip}`, street: c.address, city: c.city, state: 'ON', zip: c.zip, latitude: c.latitude, longitude: c.longitude },
      phone: c.phone,
      frequency: c.frequency,
      payment_method_info: card ? { code: 'stripe', text: 'visa - 4242', brand: 'visa', last4: '4242' } : { code: 'check', text: 'Cash / cheque' },
      services: [{ id: svc.id, name: svc.name, price: svc.price, extras: extras.map((x) => ({ ...x, total: x.price, recurring: false })), pricing_parameters: pp, commercial: svc.id === 21 }],
      teams: unassigned ? [] : [{ id: team.id, title: team.title, image: null, share: team.share, hours, earned: Math.round(team.share * hours * 100) / 100, fg_color: '#000000', bg_color: team.bg_color }],
      staff_notes: null,
      customer_notes: r.next() < 0.1 ? 'Please use the side door.' : null,
      duration,
      blocked_duration: duration,
      active: true,
      completed: past,
      created_at: iso(new Date(start.getTime() - (2 + r.int(30)) * 86_400_000)),
      created_by: { id: 1, name: 'Synthetic Data' },
      custom_fields: [
        { id: 267, title: 'Parking on Premise?', type: 'drop_down', values: [{ id: 16, label: 'Yes', name: 'yes', other: '' }] },
        { id: 270, title: 'Any Pets?', type: 'drop_down', values: [{ id: 36, label: 'No Pets', name: 'no', other: '' }] },
      ],
      summary: { services: svc.price, pricing_parameters: pp.reduce((s, p) => s + p.total, 0), extras: extras.reduce((s, x) => s + x.price, 0), discount, adjustment: 0, revenue, tax: { before_tax: revenue, tax_percent: 13, tax_amount: tax, after_tax: revenue + tax }, tip: 0, total: Math.round((revenue + tax) * 100) / 100 },
      actions: { edit: !past, cancel: !past, late_cancel: false, recurring_cancel: c.frequency.id !== 171 && !past, complete: past },
      time_tracking: tracking,
      charges: { charged, onhold: [], refunded: [], marked_paid: [], outstanding: past && !card ? Math.round((revenue + tax) * 100) / 100 : 0 },
      feedback: rated ? { stars: rating === 2 ? 5 : rating === 1 ? 2.5 : 1, rating, comment: rating === 2 ? r.pick(COMMENTS_GOOD) : r.pick(COMMENTS_BAD), rated_at: iso(new Date(checkout.getTime() + 3 * 3_600_000)) } : null,
      cancellation: null,
    };
  }

  function applyOverlay(b) {
    const o = overlay.get(b.id);
    return o ? { ...b, ...o } : b;
  }
  function findBooking(id) {
    if (created.has(id)) return applyOverlay(created.get(id));
    const date = dateOf(Math.floor(id / 100));
    return bookingsForDay(date).find((b) => b.id === id) || null;
  }
  // Without dates Launch27 returns a customer's whole history; here that means the last
  // year plus the next two months (wholeHistory). Otherwise just the given day(s).
  function bookingsInRange(from, to, wholeHistory = false) {
    const out = [];
    const today = dayIndex(new Date(now()).toISOString().slice(0, 10));
    if (wholeHistory && !from && !to) {
      for (let d = today - 365; d <= today + 60; d++) out.push(...bookingsForDay(dateOf(d)));
      return out;
    }
    const start = dayIndex(from || dateOf(today));
    const end = Math.min(dayIndex(to || from || dateOf(start)), start + 120);
    for (let d = start; d <= end; d++) out.push(...bookingsForDay(dateOf(d)));
    return out;
  }
  function teamPayload(t) {
    const team = teams.find((x) => x.id === t.id);
    return { id: t.id, title: team?.title || `Team ${t.id}`, image: null, share: t.share, hours: t.hours, earned: Math.round((t.share || 0) * (t.hours || 0) * 100) / 100, fg_color: '#000000', bg_color: team?.bg_color };
  }

  // Filters used by the app's pages.
  function filterBookings(list, q) {
    const filter = q.get('filter');
    const options = (q.get('options') || '').split(',');
    const customerId = Number(q.get('customers')) || null;
    let out = list;
    if (customerId) out = out.filter((b) => b.user.id === customerId);
    if (filter === 'cancelled') out = out.filter((b) => !b.active);
    else out = out.filter((b) => b.active);
    if (filter === 'unassigned') out = out.filter((b) => !b.teams.length);
    if (filter === 'recurring') out = out.filter((b) => b.frequency.id !== 171);
    if (filter === 'new_customer') out = out.filter((b) => b.user.is_new_customer);
    if (options.includes('with_feedback')) out = out.filter((b) => b.feedback);
    if (options.includes('completed')) out = out.filter((b) => b.completed);
    if (options.includes('not_completed')) out = out.filter((b) => !b.completed);
    const text = (q.get('query') || '').toLowerCase();
    if (text) out = out.filter((b) => `${b.id} ${b.user.name} ${b.address.full_address}`.toLowerCase().includes(text));
    return q.get('sort') === 'desc' ? [...out].reverse() : out;
  }

  const page = (list, q) => {
    const limit = Math.min(Number(q.get('limit')) || 100, 100);
    const offset = Number(q.get('offset')) || 0;
    return list.slice(offset, offset + limit);
  };

  function customersFor(q) {
    const text = (q.get('query') || '').toLowerCase();
    const digits = text.replace(/\D/g, '');
    if (!text) return customers;
    // Like Launch27, match a phone number typed with or without formatting.
    return customers.filter((c) => `${c.first_name} ${c.last_name} ${c.email} ${c.phone}`.toLowerCase().includes(text) || (digits.length >= 7 && `1${c.phone.replace(/\D/g, '')}`.endsWith(digits)));
  }

  function route(method, path, q, body) {
    let m;
    // Auth
    if (method === 'POST' && /^\/(latest|v1)\/login$/.test(path)) {
      return body?.password === password ? [200, { id: 1, type: 'Tenant::Admin', email: body.email, first_name: 'Demo', last_name: 'User', bearer: 'mock-bearer' }] : [401, { error: 'Invalid email or password (synthetic data: use MOCK_PASSWORD)' }];
    }
    if (path === '/v1/profile') return [200, { user_id: 1, user_type: 'Tenant::Admin', email: 'demo@example.com', first_name: 'Demo', last_name: 'User' }];
    if (path.startsWith('/v1/settings')) return [200, { logo: null, timezone: 'America/Toronto', currency: 'CAD' }];

    // Reference data
    if (path === '/v1/staff/locations') return [200, LOCATIONS];
    if (path === '/v1/staff/locations/count') return [200, { count: LOCATIONS.length }];
    if (path === '/v1/booking/services' || path === '/v1/staff/services') return [200, SERVICES.map((s) => ({ ...s, extras: EXTRAS, pricing_parameters: [{ id: 137, type: 'flat', name: 'Full Bathrooms', price: 27.5, quantity_minimum: 1, quantity_maximum: 7 }, { id: 138, type: 'flat', name: 'Half Bathrooms', price: 18.33, quantity_minimum: 0, quantity_maximum: 5 }] }))];
    if (path === '/v1/booking/frequencies' || path === '/v1/staff/frequencies') return [200, FREQUENCIES];
    if (path === '/v1/staff/booking_form/custom_fields' || path === '/v1/booking/custom_fields')
      return [200, [{ id: 267, control_type: 'drop_down', label: 'Parking on Premise?', value_required: true, active: true, options: [{ id: 16, label: 'Yes', active: true }, { id: 17, label: 'No', active: true }] }, { id: 270, control_type: 'drop_down', label: 'Any Pets?', value_required: true, active: true, options: [{ id: 36, label: 'No Pets', active: true }, { id: 33, label: 'Yes - Dog', active: true }] }]];

    // Teams
    if (path === '/v1/staff/teams') return [200, page(teams, q)];
    if (path === '/v1/staff/teams/count') return [200, { count: teams.length }];
    if ((m = path.match(/^\/v1\/staff\/teams\/(\d+)\/availability$/))) return [200, [0, 1, 2, 3, 4, 5, 6].map((d) => ({ id: d, date: null, weekday: d, dayoff: d === 0, start_time: d === 0 ? null : '08:00', end_time: d === 0 ? null : '17:00' }))];
    if ((m = path.match(/^\/v1\/staff\/teams\/(\d+)$/))) return (t => (t ? [200, t] : [404, { error: 'Not found' }]))(teams.find((t) => t.id === Number(m[1])));

    // Customers
    if (path === '/v1/staff/customers') return [200, page(customersFor(q), q)];
    if (path === '/v1/staff/customers/count') return [200, { count: customersFor(q).length }];
    if ((m = path.match(/^\/v1\/staff\/customers\/(\d+)(\/(phones|addresses|tags))?$/))) {
      const c = customers.find((x) => x.id === Number(m[1]));
      if (!c) return [404, { error: 'Not found' }];
      if (method === 'PUT') {
        Object.assign(c, body || {});
        return [200, c];
      }
      if (m[3] === 'phones') return [200, [{ id: 1, phone: c.phone, label: null, preferred: true }]];
      if (m[3] === 'addresses') return [200, [{ id: 1, address: c.address, city: c.city, state: c.state, zip: c.zip, preferred: true }]];
      if (m[3] === 'tags') return [200, c.tags_info || []];
      return [200, c];
    }

    // Bookings
    if (path === '/v1/staff/bookings' && method === 'GET') return [200, page(filterBookings(bookingsInRange(q.get('from'), q.get('to'), q.has('customers')), q), q)];
    if (path === '/v1/staff/bookings/count') return [200, { count: filterBookings(bookingsInRange(q.get('from'), q.get('to'), q.has('customers')), q).length }];
    if (path === '/v1/staff/bookings/time_tracking') return [200, page(bookingsInRange(q.get('from'), q.get('to')).filter((b) => b.active).map(toTimeTracking), q)];
    if (path === '/v1/staff/bookings/time_tracking/count') return [200, { count: bookingsInRange(q.get('from'), q.get('to')).filter((b) => b.active).length }];
    if (path === '/v1/staff/charges') return [200, page(bookingsInRange(q.get('from'), q.get('to')), q)];
    if (path === '/v1/staff/charges/count') return [200, { count: bookingsInRange(q.get('from'), q.get('to')).length }];
    if (path === '/v1/staff/bookings/assign/teams' && method === 'POST') {
      for (const id of body?.booking_ids || []) overlay.set(id, { ...overlay.get(id), teams: (body.teams || []).map(teamPayload) });
      return [200, {}];
    }
    if (path === '/v1/staff/bookings' && method === 'POST') {
      const id = nextId++;
      const c = customers.find((x) => x.id === body?.user?.id) || customers[0];
      const base = makeBooking(dayIndex(String(body?.service_date || '').slice(0, 10)) * 100, String(body?.service_date || dateOf(0)).slice(0, 10), rng(id));
      created.set(id, { ...base, id, user: { id: c.id, name: `${c.first_name} ${c.last_name}`, email: c.email }, service_date: torontoToUtc(body?.service_date), staff_notes: body?.staff_notes || null, customer_notes: body?.customer_notes || null, teams: (body?.teams || []).map((tid) => teamPayload({ id: Number(tid), hours: 3, share: 22 })), time_tracking: [], feedback: null, completed: false });
      return [200, { id }];
    }
    if ((m = path.match(/^\/v1\/staff\/bookings\/(\d+)(\/[a-z_]+)?$/))) {
      const id = Number(m[1]);
      const b = findBooking(id);
      if (!b) return [404, { error: 'Not found' }];
      const sub = m[2];
      if (method === 'PUT' && !sub) {
        const patch = { staff_notes: body?.staff_notes ?? b.staff_notes, customer_notes: body?.customer_notes ?? b.customer_notes };
        if (body?.service_date) patch.service_date = torontoToUtc(body.service_date);
        if (Array.isArray(body?.teams)) patch.teams = body.teams.map((t) => teamPayload(typeof t === 'object' ? t : { id: t, hours: b.duration / 60, share: 22 }));
        overlay.set(id, { ...overlay.get(id), ...patch });
        return [200, findBooking(id)];
      }
      if (method === 'POST' && sub === '/cancel') {
        overlay.set(id, { ...overlay.get(id), active: false, cancellation: { fee: 0, date: new Date(now()).toISOString(), reason: body?.reason || null, cancelled_by: { name: 'Demo User' } }, actions: { ...b.actions, edit: false, cancel: false, recurring_cancel: false } });
        return [200, {}];
      }
      if (method === 'POST' && sub === '/restore') {
        overlay.set(id, { ...overlay.get(id), active: true, cancellation: null, actions: { ...b.actions, edit: true, cancel: true } });
        return [200, {}];
      }
      if (sub === '/comments') return [200, []];
      if (sub === '/recurring') return [200, []];
      if (!sub) return [200, b];
    }

    // Reports
    if (path === '/v1/staff/reports/customer_feedbacks') return [200, []];
    if (path === '/v1/staff/reports/dashboard') return [200, dashboard(q)];

    // Anything else: empty but well-formed.
    if (method !== 'GET') return [200, {}];
    if (path.endsWith('/count')) return [200, { count: 0 }];
    return [200, []];
  }

  function toTimeTracking(b) {
    return { id: b.id, active: b.active, user: b.user, service_date: b.service_date, arrival_window: b.arrival_window, services: b.services, summary: b.summary, estimated_duration: b.duration, teams: b.teams.map((t) => ({ ...t, assigned: true, time_tracking: b.time_tracking.find((x) => x.team?.id === t.id) || null })) };
  }

  function dashboard(q) {
    const list = bookingsInRange(q.get('from'), q.get('to')).filter((b) => b.active);
    const revenue = list.reduce((s, b) => s + b.summary.revenue, 0);
    const byDay = new Map();
    for (const b of list) {
      const d = b.service_date.slice(0, 10);
      const e = byDay.get(d) || { n: 0, r: 0 };
      e.n += 1;
      e.r += b.summary.revenue;
      byDay.set(d, e);
    }
    const days = [...byDay.entries()].sort();
    const trend = { bookings_current: list.length, bookings_previous: list.length, bookings_change: 0, sales_current: revenue, sales_previous: revenue, sales_change: 0, avg_revenue_current: list.length ? revenue / list.length : 0, avg_revenue_previous: 0, avg_revenue_change: 0 };
    return {
      sales: { total_revenue: revenue, repeat_customers: { recurring_revenue: revenue * 0.75, one_time_revenue: revenue * 0.25, recurring_revenue_percent: 75 }, new_customers: { revenue: revenue * 0.1, revenue_percent: 10 }, revenue_data: { day: [['Day', 'Sales'], ...days.map(([d, e]) => [d, Math.round(e.r)])] } },
      bookings: { total_count: list.length, repeat_customers: { recurring_count: 0, one_time_count: 0, recurring_count_percent: 0 }, new_customers: { count: 0, count_percent: 0 }, active_bookings_customers_count: customers.length, recurring_bookings_customers_count: 0, bookings_data: { day: [['Day', 'Bookings'], ...days.map(([d, e]) => [d, e.n])] }, total_Estduration: 0, total_timeReported: 0, total_timecredited: 0, total_timetravel: 0 },
      customers: { count: customers.length, recurring_count: 0, recurring_percent: 0 },
      churn_data: [['Month', 'Churn / Growth']],
      extra_data: [['Extra', 'Sales']],
      trends_data: { day: trend, week: trend, month: trend, year: trend },
    };
  }

  // fetch-compatible entry point.
  return async function mockFetch(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    let body = null;
    if (init.body) {
      try {
        body = JSON.parse(typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8'));
      } catch {
        body = null;
      }
    }
    const path = u.pathname.replace(/\/+$/, '');
    const authed = method === 'POST' && /\/login$/.test(path) ? true : String(init.headers?.authorization || init.headers?.Authorization || '') === 'Bearer mock-bearer';
    if (!authed) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const [status, payload] = route(method, path, u.searchParams, body);
    return Response.json(payload, { status, headers: { 'x-synthetic-data': '1' } });
  };
}
