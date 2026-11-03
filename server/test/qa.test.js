import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAnonymizer, assertAnonymous, sensitiveStrings, maskContacts, EMAIL_MASK, PHONE_MASK } from '../src/qa/anonymize.js';
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

describe('QA copy: real names and addresses, contact details masked', () => {
  const a = createAnonymizer('fixed-salt');
  const c = a.customer(realCustomer);
  const t = a.team(realTeam);
  const b = a.booking(realBooking);

  test('masks emails, phone numbers, cards and payment processor ids', () => {
    assert.equal(c.email, 'customer4242@example.com');
    assert.match(c.phone, /^\(613\) 555-\d{4}$/);
    assert.equal(t.email, 'cleaner777@example.com');
    assert.match(t.phone, /555-/);
    assert.match(b.phone, /555-/);
    assert.equal(b.user.email, 'customer4242@example.com');
    assert.ok(!('stripe_customer_id' in c));
    assert.equal(b.payment_method_info.text, 'visa - 0000');
    assert.ok(!JSON.stringify(b).includes('pm_1US'));
  });

  test('keeps names, addresses, locations, notes, tags and staff names as in production', () => {
    assert.equal(c.first_name, 'Margaret');
    assert.equal(c.address, '4417 Riverside Drive');
    assert.equal(c.zip, 'K1V 3Z4');
    assert.equal(c.latitude, realCustomer.latitude);
    assert.equal(c.notes, realCustomer.notes);
    assert.equal(c.tags_info[0].name, 'VIP');
    assert.equal(t.title, '(PT) Esperanza Villanueva');
    assert.equal(b.user.name, 'Margaret Okonkwo-Hughes');
    assert.equal(b.address.street, '4417 Riverside Drive');
    assert.equal(b.teams[0].title, '(PT) Esperanza Villanueva');
    assert.equal(b.staff_notes, 'Margaret prefers Esperanza');
    assert.equal(b.feedback.comment, 'Esperanza was amazing, Margaret');
    assert.equal(b.created_by.name, 'Leslie Admin');
    assert.equal(b.discount_info.discount_code, 'MARGARET10');
  });

  test('emails and phones typed inside notes, answers and tags are masked; the rest of the text stays', () => {
    assert.equal(b.custom_fields[0].values[0].other, `Rottweiler named Max, call ${PHONE_MASK} first`);
    assert.equal(maskContacts('Billing: someone@gmail.com or +1 613 724 8891'), `Billing: ${EMAIL_MASK} or ${PHONE_MASK}`);
    assert.equal(maskContacts('Gate code 4412, unit 1203'), 'Gate code 4412, unit 1203');
    const tagged = a.customer({ ...realCustomer, tags_info: [{ id: 1, name: 'Text 6137248891 before' }, { id: 2, name: 'Prefers Esperanza' }] });
    assert.deepEqual(tagged.tags_info.map((x) => x.name), [`Text ${PHONE_MASK} before`, 'Prefers Esperanza']);
  });

  test('keeps everything the screens need: prices, services, extras, times, assignments', () => {
    assert.deepEqual(b.summary, realBooking.summary);
    assert.equal(b.services[0].extras[0].discount_by_frequency, false);
    assert.equal(b.service_date, realBooking.service_date);
    assert.equal(b.time_tracking[0].checkout_at, realBooking.time_tracking[0].checkout_at);
    assert.equal(b.teams[0].id, 777);
  });

  test('the full copy passes the contact-details check against the real values', () => {
    const copy = { customers: [c], teams: [t], bookings: [b] };
    assert.ok(assertAnonymous(copy, sensitiveStrings({ customers: [realCustomer], teams: [realTeam], bookings: [realBooking] })));
  });

  test('the check catches a real email or phone anywhere and says where (never the value)', () => {
    const leaky = { bookings: [{ ...b, staff_notes: 'call margaret.oh@gmail.com' }] };
    assert.throws(() => assertAnonymous(leaky), (e) => /email/.test(e.message) && /bookings\[\]\.staff_notes/.test(e.message) && !e.message.includes('gmail'));
    assert.throws(() => assertAnonymous({ customers: [{ ...c, phone: '(613) 724-8891' }] }), /phone/);
    const real = sensitiveStrings({ customers: [realCustomer] });
    assert.throws(() => assertAnonymous({ customers: [{ ...c, notes: 'reach at 613-724-8891' }] }, real), /phone|real value/);
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

  test('future recurring visits Launch27 only forecasts (no id) all make it into the copy, with their cleaner', async () => {
    const forecast = (date) => ({ ...realBooking, id: null, forecasted_from_booking: { id: realBooking.id }, service_date: `${date}T14:00:00Z` });
    const get = async (path, q = {}) => {
      if (path === '/v1/staff/bookings') return q.offset || q.filter || q.options ? [] : [realBooking, forecast('2026-11-17'), forecast('2026-12-01'), forecast('2026-12-15')];
      if (path === '/v1/staff/customers') return q.offset ? [] : [realCustomer];
      if (path === '/v1/staff/teams') return q.offset ? [] : [realTeam];
      return [];
    };
    const copy = await buildSnapshot(get, { now: Date.parse('2026-11-01T12:00:00Z') });
    const f = copy.bookings.filter((b) => !b.id);
    assert.equal(f.length, 3, 'one per forecast date, not collapsed into one');
    assert.ok(f.every((b) => b.forecasted_from_booking.id === realBooking.id && b.teams.length === realBooking.teams.length));
    const mock = createMockLaunch27({ password: 'demo', snapshot: () => copy });
    const call = async (p) => (await mock(`https://mock${p}`, { headers: { authorization: 'Bearer mock-bearer' } })).json();
    assert.equal((await call('/v1/staff/bookings?from=2026-11-15&to=2026-12-20')).length, 3);
  });

  test('QA serves "active only" cleaner lists like Launch27 (the copy holds former cleaners too)', async () => {
    const copy = { teams: [{ id: 1, title: '(1) A B', active: true }, { id: 2, title: 'C D', active: false }, { id: 3, title: '(2) E F' }], customers: [], bookings: [], services: {}, locations: [] };
    const mock = createMockLaunch27({ password: 'demo', snapshot: () => copy });
    const call = async (p) => (await mock(`https://mock${p}`, { headers: { authorization: 'Bearer mock-bearer' } })).json();
    assert.deepEqual((await call('/v1/staff/teams?filter=active')).map((t) => t.id), [1, 3]);
    assert.equal((await call('/v1/staff/teams/count?filter=active')).count, 2);
    assert.equal((await call('/v1/staff/teams')).length, 3);
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

describe('QA copy without forecasts: future recurring visits are rebuilt', () => {
  test('repeats each live series on its rhythm with its cleaner, never doubles a date, skips stopped series', async () => {
    const { forecastMissing } = await import('../src/mock/launch27.js');
    const b = (id, user, date, freq, team) => ({ id, user: { id: user }, frequency: { name: freq }, service_date: `${date}T14:00:00Z`, active: true, teams: [{ id: team }] });
    const copy = {
      created_at: '2026-11-03T12:00:00Z',
      window: { from: '2026-09-04', to: '2026-12-31' },
      bookings: [
        b(1, 10, '2026-11-02', 'Biweekly - 10% off', 7), // biweekly Monday with cleaner 7
        b(2, 10, '2026-11-30', 'Biweekly - 10% off', 7), // already in the copy: must not be doubled
        b(3, 11, '2026-11-04', 'Monthly', 8),
        b(4, 12, '2026-09-07', 'Weekly', 9), // stopped in September
        b(5, 13, '2026-11-05', 'One time', 9),
      ],
    };
    const f = forecastMissing(copy);
    const dates = (u) => f.filter((x) => x.user.id === u).map((x) => x.service_date.slice(0, 10));
    assert.deepEqual(dates(10), ['2026-12-14', '2026-12-28'], 'from the latest visit, every 2 weeks');
    assert.deepEqual(dates(11), ['2026-12-02', '2026-12-30']);
    assert.deepEqual(dates(12), []);
    assert.deepEqual(dates(13), []);
    assert.ok(f.every((x) => x.id === null && x.forecasted_from_booking.id && x.teams.length === 1 && !x.completed));
    assert.equal(f.find((x) => x.user.id === 10).teams[0].id, 7, 'keeps the cleaner');
  });
});
