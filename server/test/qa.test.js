import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAnonymizer, assertAnonymous, sensitiveStrings, NOTE, cleanTag, personTokens } from '../src/qa/anonymize.js';
import { buildSnapshot } from '../src/qa/snapshot.js';
import { createQaStore } from '../src/qa/service.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// A made-up record shaped exactly like Launch27's, full of personal details.
const realCustomer = { id: 4242, first_name: 'Margaret', last_name: 'Okonkwo-Hughes', email: 'margaret.oh@gmail.com', phone: '(613) 724-8891', address: '4417 Riverside Drive', city: 'Ottawa', state: 'ON', zip: 'K1V 3Z4', latitude: 45.3611, longitude: -75.6812, notes: 'Lockbox 4412, husband works nights so be quiet', company_name: null, active: true, created_at: '2019-04-02T00:00:00Z', tags_info: [{ id: 1, name: 'VIP' }], stripe_customer_id: 'cus_ABCDEF1234567890' };
const realTeam = { id: 777, title: '(PT) Esperanza Villanueva', first_name: 'Esperanza', last_name: 'Villanueva', email: 'esperanza.v@hotmail.com', phone: '613-555-0000x', address: '88 Bank Street Apt 4', city: 'Ottawa', zip: 'K2P 1A1', latitude: 45.41, longitude: -75.69, notes: 'Has a car', active: true, bg_color: '#ffb8b8', share: 22, rating: 4.9, locations: [{ id: 1, name: 'Ottawa' }] };
const realBooking = {
  id: 129354, active: true, completed: true, service_date: '2026-10-20T15:00:00Z', arrival_window: 60, duration: 210,
  user: { id: 4242, name: 'Margaret Okonkwo-Hughes', email: 'margaret.oh@gmail.com' }, phone: '(613) 724-8891',
  address: { full_address: '4417 Riverside Drive, Ottawa, ON K1V 3Z4', street: '4417 Riverside Drive', city: 'Ottawa', state: 'ON', zip: 'K1V 3Z4', latitude: 45.3611, longitude: -75.6812 },
  location: { id: 1, name: 'Ottawa' }, frequency: { id: 171, name: 'One time' }, created_by: { id: 9, name: 'Leslie Admin' },
  services: [{ id: 1182, name: 'Three Bedroom Home', price: 151.25, discount_by_frequency: true, discount_by_code: true, pricing_parameters: [{ id: 137, name: 'Full Bathrooms', quantity: 2, price: 27.5, total: 55 }], extras: [{ id: 227, name: 'Move In Move Out', quantity: 1, price: 210.83, total: 210.83, discount_by_frequency: false }] }],
  summary: { services: 151.25, pricing_parameters: 55, extras: 210.83, discount: 41.71, adjustment: 0, revenue: 375.37, tax: { before_tax: 375.37, tax_percent: 13, tax_amount: 48.8, after_tax: 424.17 }, tip: 0, total: 424.17 },
  discount_info: { discount_amount: 41.71, discount_code: 'MARGARET10' },
  payment_method_info: { code: 'stripe', text: 'visa - 8857', brand: 'visa', last4: '8857', stripe_payment_method_id: 'pm_1USeuYH7QLo85uOkV4U021n1' },
  custom_fields: [{ id: 270, title: 'Any Pets?', values: [{ id: 33, label: 'Yes - Dog', other: 'Rottweiler named Max, call 613-724-8891 first' }] }],
  staff_notes: 'Margaret prefers Esperanza', customer_notes: 'Please use side door',
  teams: [{ id: 777, title: '(PT) Esperanza Villanueva', share: 22, hours: 3.5, earned: 77 }],
  time_tracking: [{ id: 1, team: { id: 777, title: 'Esperanza Villanueva' }, checkin_at: '2026-10-20T15:05:00Z', checkout_at: '2026-10-20T18:40:00Z', checkin_latitude: 45.3612, checkin_longitude: -75.6811 }],
  charges: { charged: [{ id: 5, amount: 424.17, status: 'paid', description: 'Charge for Margaret Okonkwo-Hughes', payment_method_info: { code: 'stripe', text: 'visa - 8857' } }], outstanding: 0 },
  feedback: { rating: 2, stars: 5, comment: 'Esperanza was amazing, Margaret' },
};

describe('QA copy: anonymizer', () => {
  const a = createAnonymizer('fixed-salt');
  const c = a.customer(realCustomer);
  const t = a.team(realTeam);
  const b = a.booking(realBooking);

  test('replaces names, contact details, addresses, notes, cards and ids', () => {
    assert.match(c.email, /@example\.com$/);
    assert.match(c.phone, /555-/);
    assert.notEqual(c.address, realCustomer.address);
    assert.equal(c.zip, 'K1V 0A0', 'keeps the area, not the exact postal code');
    assert.equal(c.city, 'Ottawa');
    assert.equal(c.notes, NOTE);
    assert.ok(!('stripe_customer_id' in c));
    assert.ok(Math.abs(c.latitude - realCustomer.latitude) > 0.001, 'location shifted');
    assert.match(t.title, /^\(PT\) /, 'keeps the part-time prefix');
    assert.ok(!t.title.includes('Esperanza'));
    assert.equal(b.payment_method_info.text, 'visa - 0000');
    assert.equal(b.custom_fields[0].values[0].label, 'Yes - Dog', 'booking answers kept');
    assert.equal(b.custom_fields[0].values[0].other, NOTE, '"Other" text removed');
    assert.equal(b.feedback.rating, 2);
    assert.equal(b.feedback.comment, NOTE);
    assert.equal(b.created_by.name, 'Office staff');
    assert.equal(b.discount_info.discount_code, 'QACODE');
  });

  test('keeps everything the screens need: prices, services, extras, times, assignments', () => {
    assert.deepEqual(b.summary, realBooking.summary);
    assert.equal(b.services[0].extras[0].discount_by_frequency, false);
    assert.equal(b.service_date, realBooking.service_date);
    assert.equal(b.time_tracking[0].checkout_at, realBooking.time_tracking[0].checkout_at);
    assert.equal(b.teams[0].id, 777);
  });

  test('the same person gets the same fake name everywhere', () => {
    assert.equal(b.user.name, `${c.first_name} ${c.last_name}`);
    assert.equal(b.teams[0].title, `${t.first_name} ${t.last_name}`);
    assert.equal(b.time_tracking[0].team.title, b.teams[0].title);
  });

  test('the full copy passes the anonymity check against the real values', () => {
    const copy = { customers: [c], teams: [t], bookings: [b] };
    assert.ok(assertAnonymous(copy, sensitiveStrings({ customers: [realCustomer], teams: [realTeam], bookings: [realBooking] })));
  });

  test('the check catches leaks and says where (never the value)', () => {
    const leaky = { bookings: [{ ...b, staff_notes: 'call margaret.oh@gmail.com' }] };
    assert.throws(() => assertAnonymous(leaky), (e) => /email/.test(e.message) && /bookings\[\]\.staff_notes/.test(e.message) && !e.message.includes('gmail'));
    const real = sensitiveStrings({ customers: [realCustomer] });
    assert.throws(() => assertAnonymous({ customers: [{ ...c, address: '4417 Riverside Drive' }] }, real), /real value/);
  });

  test('short real values must match a whole field; long ones are caught anywhere', () => {
    const real = new Set(['oak', '4417 riverside drive']);
    assert.ok(assertAnonymous({ notes: 'Oakwood Avenue' }, real));
    assert.throws(() => assertAnonymous({ city: 'Toronto, Oak' }, real), /1 real value.*Fields: city \(1\)/);
    assert.throws(() => assertAnonymous({ notes: 'key under mat at 4417 Riverside Drive' }, real), /Fields: notes \(1\)/);
  });
});

describe('QA copy: tags are staff-typed text', () => {
  test('tags naming a person, or holding an email or phone, are replaced; generic tags stay', () => {
    const people = personTokens({ customers: [realCustomer], teams: [realTeam] });
    assert.equal(cleanTag('Prefers Esperanza', people), 'Prefers a specific cleaner');
    assert.equal(cleanTag('Do not assign Villanueva', people), 'Do not assign a specific cleaner');
    assert.equal(cleanTag('Esperanza Villanueva', people), 'Tag removed for QA');
    assert.equal(cleanTag('Billing contact: someone@gmail.com', people), 'Tag removed for QA');
    assert.equal(cleanTag('Call 613-724-8891 first', people), 'Tag removed for QA');
    assert.equal(cleanTag('Assign two cleaners', people), 'Assign two cleaners');
    assert.equal(cleanTag('VIP', people), 'VIP');
    const a = createAnonymizer('s', people);
    assert.equal(a.customer({ ...realCustomer, tags_info: [{ id: 1, name: 'Prefers Esperanza' }, { id: 2, name: 'VIP' }] }).tags_info.map((t) => t.name).join('|'), 'Prefers a specific cleaner|VIP');
  });
});

describe('QA copy: build, receive, serve', () => {
  test('builds from Launch27 and serves it in QA', async () => {
    // Stand-in for Launch27 returning the real-looking records above.
    const get = async (path, q = {}) => {
      if (path === '/v1/staff/bookings') return q.offset ? [] : [realBooking];
      if (path === '/v1/staff/customers') return q.offset ? [] : [realCustomer];
      if (path === '/v1/staff/teams') return q.offset ? [] : [realTeam];
      if (path === '/v1/staff/locations') return [{ id: 1, name: 'Ottawa', active: true }];
      if (path === '/v1/booking/services') return [{ id: 1182, name: 'Three Bedroom Home', price: 151.25, extras: [], pricing_parameters: [] }];
      if (path === '/v1/booking/frequencies' || path === '/v1/staff/frequencies') return [{ id: 171, name: 'One time', percent: 0 }];
      if (path.endsWith('/setup/billing')) return { cards: [{ brand: 'visa', last4: '8857', exp_month: 8, exp_year: 2028 }], stripe_customer_id: 'cus_X' };
      return [];
    };
    const copy = await buildSnapshot(get, { now: Date.parse('2026-11-01T12:00:00Z') });
    assert.equal(copy.bookings.length, 1);
    assert.equal(copy.cards['4242'].cards[0].last4, '0000');

    const db = await openDb();
    const log = { info() {}, warn() {}, error() {} };
    const store = createQaStore({ db, log });
    const config = { ...loadConfig({ APP_ENV: 'staging', L27_MODE: 'mock', MOCK_PASSWORD: 'demo', QA_SNAPSHOT_TOKEN: 'x'.repeat(40) }), qaSnapshotReceive: true };
    const server = createApp(config, { db, qa: { store } }).listen(0);
    const url = `http://127.0.0.1:${server.address().port}/qa/snapshot`;
    try {
      const put = (body, token) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      assert.equal((await put(copy, 'wrong')).status, 401);
      const leaky = { ...copy, customers: [{ ...copy.customers[0], email: 'real@gmail.com' }] };
      assert.equal((await put(leaky, 'x'.repeat(40))).status, 422, 'QA refuses anything personal');
      const ok = await put(copy, 'x'.repeat(40));
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).summary.bookings, 1);

      // The synthetic Launch27 now serves the copy.
      const mock = createMockLaunch27({ password: 'demo', snapshot: () => store.current() });
      const call = async (p) => (await mock(`https://mock${p}`, { headers: { authorization: 'Bearer mock-bearer' } })).json();
      const day = await call('/v1/staff/bookings?from=2026-10-20&to=2026-10-20');
      assert.equal(day.length, 1);
      assert.equal(day[0].id, 129354);
      assert.equal(day[0].summary.total, 424.17);
      assert.match(day[0].user.email, /@example\.com$/);
      const cust = await call('/v1/staff/customers/4242');
      assert.equal(cust.first_name, copy.customers[0].first_name);
      assert.equal((await call('/v1/staff/customers/4242/setup/billing')).cards[0].last4, '0000');
      assert.equal((await call('/v1/booking/services?location_id=1'))[0].name, 'Three Bedroom Home');

      // Survives a restart.
      const again = createQaStore({ db, log });
      assert.equal((await again.load()).bookings, 1);
    } finally {
      server.close();
      await db.close();
    }
  });

  test('production never receives a copy; QA never sends one', () => {
    const prod = loadConfig({ APP_ENV: 'production', QA_SNAPSHOT_TOKEN: 'x'.repeat(40), QA_SNAPSHOT_URL: 'https://qa.example.com' });
    assert.equal(prod.qaSnapshotReceive, false);
    assert.equal(prod.qaSnapshotUrl, 'https://qa.example.com');
    const qa = loadConfig({ APP_ENV: 'staging', QA_SNAPSHOT_TOKEN: 'x'.repeat(40), QA_SNAPSHOT_URL: 'https://somewhere' });
    assert.equal(qa.qaSnapshotReceive, true);
    assert.equal(qa.qaSnapshotUrl, null);
  });
});
