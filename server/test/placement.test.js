import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runConformance } from 'placement-contract/conformance';
import { validate } from 'placement-contract';
import {
  bookingBody, catalogService, customFieldsFrom, frequencyMap, homeKeyOf, locationFor, priceQuote, questionsOf, quotableServices, staffNotesFor, suggestBrand, taxPercentFor,
} from '../src/placement/mapping.js';
import { createPlacement, torontoIso } from '../src/placement/service.js';
import { callerFor } from '../src/placement/api.js';
import { configErrors, loadConfig, parsePlacementTokens } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { createSchedule } from '../src/schedule/service.js';
import { createWriteLog } from '../src/writes.js';

const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} }); // the app also calls log(level, ...)
const TOKEN = 'hub-token-0123456789abcdefghijklmnopqrstuvwxyz';

describe('placement: mapping Launch27 onto the contract', () => {
  test('brands by location name, as on the web side', () => {
    assert.equal(suggestBrand('Ottawa'), 'residential');
    assert.equal(suggestBrand('Commercial Ottawa'), 'commercial');
    assert.equal(suggestBrand('Cornwall'), 'commercial');
    assert.equal(suggestBrand('Somewhere else'), null);
  });

  test('frequencies: first non-prepaid of each kind; every-3-weeks has no contract value', () => {
    const m = frequencyMap([{ id: 1, name: 'Prepaid Biweekly' }, { id: 2, name: 'Biweekly - 10% off' }, { id: 3, name: 'One time' }, { id: 4, name: 'Tri-Weekly' }, { id: 5, name: 'Monthly - 5% off' }]);
    assert.equal(m.get('biweekly').id, 2);
    assert.equal(m.get('one_time').id, 3);
    assert.equal(m.get('every_4_weeks').id, 5);
    assert.deepEqual([...m.keys()].sort(), ['biweekly', 'every_4_weeks', 'one_time']);
  });

  test('services: $0 services are left to people; rooms map to home details; hourly is declared', () => {
    const svcs = [
      { id: 1, name: 'Two Bedroom Home', price: 137.5, duration: 150, pricing_parameters: [{ id: 137, name: 'Full Bathrooms', quantity_minimum: 1, quantity_maximum: 7 }, { id: 138, name: 'Half Bathrooms', quantity_minimum: 0 }], extras: [{ id: 9, name: 'Inside Oven', quantity_based: true }] },
      { id: 2, name: 'Commercial', price: 0, pricing_parameters: [], extras: [] },
      { id: 3, name: 'Odd', price: 50, pricing_parameters: [{ id: 1, name: 'Number of stairs' }], extras: [] },
      { id: 4, name: 'Hourly Cleaning', price: 55, hourly: { minutes_minimum: 180, minutes_maximum: 720, half_hour_increments: true }, pricing_parameters: [], extras: [] },
    ];
    assert.deepEqual(quotableServices(svcs).map((s) => s.id), [1, 4]);
    const two = catalogService(svcs[0]);
    assert.deepEqual(two.home_fields.map((f) => [f.key, f.required]), [['bathrooms', true], ['half_bathrooms', false]]);
    assert.equal(two.extras[0].max_quantity, 10);
    assert.deepEqual(catalogService(svcs[3]).hourly, { min_minutes: 180, max_minutes: 720, step_minutes: 30 });
    assert.equal(homeKeyOf('Half Bathrooms'), 'half_bathrooms');
  });

  test('booking questions: markup stripped, link kept, required answers enforced', () => {
    const fields = [
      { id: 267, control_type: 'drop_down', label: 'Parking on Premise?', value_required: true, options: [{ id: 16, label: 'Yes' }, { id: 17, label: 'No' }] },
      { id: 256, control_type: 'checkbox', label: 'You agree to <a href="https://example.com/terms" target="_blank"><u>our Terms</u></a>.', value_required: true, options: [] },
      { id: 262, control_type: 'plain_text', label: 'Additional Notes', value_required: false, options: [] },
      { id: 261, control_type: 'multi_line', label: '', value_required: false, options: [] },
    ];
    const qs = questionsOf(fields);
    assert.deepEqual(qs.map((q) => [q.id, q.type, q.required]), [['267', 'single_choice', true], ['256', 'checkbox', true], ['262', 'text', false]]);
    assert.equal(qs[1].label, 'You agree to our Terms.');
    assert.equal(qs[1].url, 'https://example.com/terms');
    for (const q of qs) assert.deepEqual(validate('Question', q), []);

    assert.deepEqual(customFieldsFrom(fields, []).missing, ['267', '256']);
    // A required checkbox answered false is not an answer.
    assert.deepEqual(customFieldsFrom(fields, [{ question_id: '267', option_ids: ['16'] }, { question_id: '256', value: false }]).missing, ['256']);
    // An option that doesn't exist is not an answer either.
    assert.deepEqual(customFieldsFrom(fields, [{ question_id: '267', option_ids: ['99'] }, { question_id: '256', value: true }]).missing, ['267']);
    const ok = customFieldsFrom(fields, [{ question_id: '267', option_ids: ['16'] }, { question_id: '256', value: true }, { question_id: '262', value: ' Side door ' }]);
    assert.deepEqual(ok.missing, []);
    // Launch27's shapes: drop-downs as values, checkboxes as the strings "true"/"false".
    assert.deepEqual(ok.custom_fields, [{ id: 267, values: [{ id: 16, other: null }] }, { id: 256, value: 'true' }, { id: 262, value: 'Side door' }]);
  });

  test('locations: brand first, then the longest postcode prefix, then the default', () => {
    const locs = [
      { id: 1, name: 'Ottawa', default: true, postcodes: ['K1', 'K2'] },
      { id: 3, name: 'Carpet Cleaning', postcodes: ['K1'] },
      { id: 4, name: 'Ottawa East', postcodes: ['K1K'] },
      { id: 167, name: 'Commercial Ottawa', postcodes: ['K1', 'K1A'] },
      { id: 2, name: 'Kitchener-Waterloo', postcodes: ['N2L'] },
    ];
    const brandOf = (l) => suggestBrand(l.name);
    assert.equal(locationFor(locs, 'k1a 0b1', 'residential', brandOf).id, 1);
    assert.equal(locationFor(locs, 'K1K 2A1', 'residential', brandOf).id, 4);
    assert.equal(locationFor(locs, 'N2L 3G1', 'residential', brandOf).id, 2);
    assert.equal(locationFor(locs, 'K1A 0B1', 'commercial', brandOf).id, 167);
    assert.equal(locationFor(locs, 'M5V 1A1', 'residential', brandOf), null);
  });

  test('tax: latest rate already in effect for the location', () => {
    const taxes = [{ effective_date: '2020-01-01', percent: 13, locations: [] }, { effective_date: '2027-01-01', percent: 15, locations: [] }, { effective_date: '2025-01-01', percent: 5, locations: [{ id: 9 }] }];
    assert.equal(taxPercentFor(taxes, 1, '2026-11-11'), 13);
    assert.equal(taxPercentFor(taxes, 9, '2026-11-11'), 5);
  });

  const two = { id: 1181, name: 'Two Bedroom Home', price: 137.5, duration: 150, pricing_parameters: [{ id: 137, name: 'Full Bathrooms', price: 27.5, quantity_minimum: 1, quantity_maximum: 7 }, { id: 138, name: 'Half Bathrooms', price: 18.33, quantity_minimum: 0, quantity_maximum: 7 }], extras: [{ id: 228, name: 'Inside Fridge', price: 55, duration: 60, recurring: true }, { id: 226, name: 'Deep Cleaning', price: 82.5, duration: 90, recurring: false }], discount_by_frequency: true, discount_by_code: true };
  const address = { line1: '100 Example Street', city: 'Ottawa', region: 'ON', postal_code: 'K1A 0B1', country: 'CA' };
  const biweekly = { id: 12, name: 'Biweekly - 10% off', percent: 10 };

  test('quote: priced with Launch27 rules; recurring visits repeat only recurring extras', () => {
    const req = { brand: 'urbanmop-residential', address, service_code: '1181', frequency: 'biweekly', home: { bathrooms: 2 }, extras: [{ code: '228', quantity: 1 }, { code: '226', quantity: 1 }] };
    const q = priceQuote({ service: two, request: req, frequency: biweekly, recurringFrequency: biweekly, taxPercent: 13 });
    // First visit: 137.50 + 2 × 27.50 + 55 + 82.50 = 330.00; less 10% = 297.00; + 13% HST = 335.61.
    assert.deepEqual(q.price.first_visit, { amount_cents: 33561, currency: 'CAD' });
    // Later visits: 137.50 + 55 + 55 = 247.50; less 10% = 222.75; + 13% = 251.71.
    assert.deepEqual(q.price.recurring_visit, { amount_cents: 25171, currency: 'CAD' });
    assert.equal(q.duration_minutes, 150 + 60 + 90);
    // Every pricing parameter is sent, even at 0 (Launch27 requires it).
    assert.deepEqual(q.l27_line, { id: 1181, pricing_parameters: [{ id: 137, quantity: 2 }, { id: 138, quantity: 0 }], extras: [{ id: 228, quantity: 1, recurring: null }, { id: 226, quantity: 1, recurring: null }] });
    assert.ok(q.price.lines.some((l) => l.amount.amount_cents < 0), 'the discount is shown as a negative line');
  });

  test('quote: rejects what the service does not allow', () => {
    const base = { brand: 'urbanmop-residential', address, service_code: '1181', frequency: 'one_time' };
    assert.throws(() => priceQuote({ service: two, request: { ...base, home: { bathrooms: 0 } }, frequency: biweekly, taxPercent: 13 }), /Full Bathrooms/);
    assert.throws(() => priceQuote({ service: two, request: { ...base, extras: [{ code: '999', quantity: 1 }] }, frequency: biweekly, taxPercent: 13 }), /isn't offered/);
    assert.throws(() => priceQuote({ service: two, request: { ...base, extras: [{ code: '228', quantity: 2 }] }, frequency: biweekly, taxPercent: 13 }), /at most 1/);
    const hourly = { id: 1186, name: 'Hourly Cleaning', price: 55, hourly: { quantity_minimum: 1, minutes_minimum: 180, minutes_maximum: 720, half_hour_increments: true }, pricing_parameters: [], extras: [] };
    assert.throws(() => priceQuote({ service: hourly, request: { ...base, service_code: '1186' }, frequency: biweekly, taxPercent: 13 }), /send minutes/);
    assert.throws(() => priceQuote({ service: hourly, request: { ...base, service_code: '1186', minutes: 200 }, frequency: biweekly, taxPercent: 13 }), /steps of 30/);
    const h = priceQuote({ service: hourly, request: { ...base, service_code: '1186', minutes: 240 }, frequency: { id: 171, name: 'One time', percent: 0 }, taxPercent: 13 });
    assert.equal(h.duration_minutes, 240);
    assert.deepEqual(h.price.first_visit, { amount_cents: 24860, currency: 'CAD' }); // 55 × 4 h = 220 + 13%
    assert.deepEqual(h.l27_line, { id: 1186, hourly: { quantity: 1, minutes: 240 } });
  });

  test('booking body: the same shape as the booking form, cleaner assigned', () => {
    const body = bookingBody({
      quote: { location_id: 1, frequency_id: 12, l27_line: { id: 1181 }, address },
      slot: { date: '2026-11-13', start: 540, end: 690, cleaner_id: 7, arrival_window: 60 },
      customer: { first_name: 'Test', last_name: 'Customer', email: 'test@example.com', phone: '613-555-0100' },
      customFields: [{ id: 256, value: 'true' }],
      paymentMethod: 'check',
      staffNotes: 'n',
    });
    assert.deepEqual(body.user, { first_name: 'Test', last_name: 'Customer', email: 'test@example.com' });
    assert.equal(body.service_date, '2026-11-13T09:00:00');
    assert.equal(body.zip, 'K1A 0B1');
    assert.deepEqual(body.teams, [7]);
    assert.equal(bookingBody({ quote: { address }, slot: { date: '2026-11-13', start: 540 }, customer: {}, existingCustomerId: 55 }).user.id, 55);
    assert.match(staffNotesFor({ accessNotes: 'Key under mat', placedBy: { kind: 'sales_rep', id: 'r7', display_name: 'Rep Seven' }, caller: 'sales-hub', leadRef: 'lead_1', source: { channel: 'phone' } }), /^Key under mat\n\nBooked through sales-hub by Rep Seven \(sales_rep r7\), lead lead_1, source phone\.$/);
  });

  test('times carry the Toronto offset, through daylight saving', () => {
    assert.equal(torontoIso('2026-11-13', 540), '2026-11-13T09:00:00-05:00');
    assert.equal(torontoIso('2026-07-01', 810), '2026-07-01T13:30:00-04:00');
    assert.equal(torontoIso('2026-03-08', 600), '2026-03-08T10:00:00-04:00'); // DST starts 2am that day
  });
});

describe('placement: config and auth', () => {
  test('tokens are name:token pairs of 32+ characters', () => {
    const { tokens, bad } = parsePlacementTokens(`sales-hub:${TOKEN}, booking-form:${TOKEN}x,short:abc,:${TOKEN}`);
    assert.deepEqual([...tokens.keys()], ['sales-hub', 'booking-form']);
    assert.deepEqual(bad, ['short', '(unnamed)']);
    assert.ok(configErrors(loadConfig({ L27_MODE: 'mock', PLACEMENT_TOKENS: 'hub:short' })).some((e) => e.startsWith('PLACEMENT_TOKENS')));
    assert.equal(callerFor(tokens, `Bearer ${TOKEN}`), 'sales-hub');
    assert.equal(callerFor(tokens, `Bearer ${TOKEN}y`), null);
    assert.equal(callerFor(tokens, ''), null);
  });

  test('placement login is only read for the live Launch27', () => {
    const live = loadConfig({ APP_ENV: 'production', L27_MODE: 'live', L27_PLACEMENT_EMAIL: 'p@example.com', L27_PLACEMENT_PASSWORD: 'x', PLACEMENT_TOKENS: `hub:${TOKEN}` });
    assert.equal(live.l27PlacementEmail, 'p@example.com');
    assert.equal(loadConfig({ L27_MODE: 'mock', L27_PLACEMENT_EMAIL: 'p@example.com' }).l27PlacementEmail, null);
    assert.ok(loadConfig({ L27_MODE: 'live', PLACEMENT_TOKENS: `hub:${TOKEN}` }).warnings.some((w) => /L27_PLACEMENT_EMAIL/.test(w)));
  });
});

describe('placement: the app against the synthetic Launch27', () => {
  let db;
  let server;
  let baseUrl;
  let writes;
  let schedule;
  let placement;
  let mock;
  const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo', PLACEMENT_TOKENS: `sales-hub:${TOKEN}` });
  // The router checks its own answers against the contract outside production and warns on drift.
  const problems = [];
  const appLog = Object.assign(() => {}, { info() {}, warn: (msg, f) => problems.push([msg, f]), error: (msg, f) => problems.push([msg, f]) });
  const brand = 'urbanmop-residential';
  const quoteRequest = { brand, address: { line1: '100 Example Street', city: 'Ottawa', region: 'ON', postal_code: 'K1A 0B1', country: 'CA' }, service_code: '1181', frequency: 'one_time', home: { bathrooms: 1 } };
  const answers = [
    { question_id: '267', option_ids: ['16'] },
    { question_id: '270', option_ids: ['32'] },
    { question_id: '269', option_ids: ['24'] },
    { question_id: '256', value: true },
    { question_id: '271', value: true },
  ];
  const customer = { first_name: 'Test', last_name: 'Customer', email: 'placement-test@example.com', phone: '613-555-0142' };
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${baseUrl}/api/placement/v1${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  before(async () => {
    db = await openDb();
    mock = createMockLaunch27({ password: 'demo' });
    writes = createWriteLog({ db, log: quiet });
    schedule = createSchedule({ db, config, fetchImpl: mock, log: quiet, writes });
    await schedule.sync();
    placement = createPlacement({ db, config, fetchImpl: mock, schedule, writes, log: quiet });
    server = createApp(config, { db, fetchImpl: mock, placement, schedule, writes, log: appLog }).listen(0);
    await new Promise((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.closeAllConnections();
    server.close();
    await db.close();
  });

  test('passes the shared conformance checks, holds and booking included', async () => {
    const results = await runConformance({ baseUrl, token: TOKEN, brand, quoteRequest, holds: true, book: { customer, answers, placed_by: { kind: 'sales_rep', id: 'rep_7', display_name: 'Rep Seven' } } });
    const failed = results.filter((r) => !r.ok);
    assert.deepEqual(failed, []);
    assert.ok(results.some((r) => r.name === 'bookings: missing required answers is invalid_request'));
    assert.ok(results.some((r) => r.name === 'bookings: same Idempotency-Key replays without booking again'));
    // The booking went through the write log, attributed to the hub and the rep.
    const logged = (await writes.list()).rows.filter((r) => r.source === 'placement' && r.outcome === 'done');
    assert.equal(logged.length, 1);
    assert.match(logged[0].user_email, /^sales-hub \/ sales_rep rep_7$/);
    const sent = typeof logged[0].request === 'string' ? JSON.parse(logged[0].request) : logged[0].request;
    assert.equal(sent.teams.length, 1);
    assert.match(sent.staff_notes, /Booked through sales-hub by Rep Seven/);
    assert.ok(sent.custom_fields.some((f) => f.id === 256 && f.value === 'true'));
  });

  test('catalog lists quotable residential services, hourly ones and the booking questions', async () => {
    const { status, body } = await call('GET', `/catalog?brand=${brand}`);
    assert.equal(status, 200);
    assert.ok(body.services.some((s) => s.code === '1181'));
    assert.ok(body.services.some((s) => s.hourly));
    assert.ok(!body.services.some((s) => s.name === 'Commercial'));
    assert.ok(body.questions.some((q) => q.id === '256' && q.type === 'checkbox' && q.required && q.url));
    assert.equal((await call('GET', '/catalog?brand=urbanmop-commercial')).body.error.code, 'brand_not_served');
  });

  test('an address outside every residential location is not serviceable', async () => {
    const { status, body } = await call('POST', '/quote', { ...quoteRequest, address: { ...quoteRequest.address, postal_code: 'M5V 1A1' } });
    assert.equal(status, 200);
    assert.deepEqual([body.serviceable, body.not_serviceable_reason], [false, 'outside_service_area']);
  });

  test('a held slot disappears from availability until it is released', async () => {
    const q = (await call('POST', '/quote', quoteRequest)).body;
    const from = placement._addDays(placement._today(), 1);
    const to = placement._addDays(from, 6);
    const first = (await call('GET', `/availability?quote_id=${q.quote_id}&from=${from}&to=${to}`)).body;
    assert.ok(first.slots.length > 0);
    const slot = first.slots[0];
    assert.match(slot.start, /T\d{2}:\d{2}:00-0[45]:00$/);
    const hold = await call('POST', '/holds', { slot_token: slot.slot_token, placed_by: { kind: 'sales_rep', id: 'r1' } });
    assert.equal(hold.status, 201);
    const during = (await call('GET', `/availability?quote_id=${q.quote_id}&from=${from}&to=${to}`)).body;
    assert.ok(!during.slots.some((s) => s.start === slot.start && s.team.id === slot.team.id));
    assert.equal((await call('DELETE', `/holds/${hold.body.hold_id}`)).status, 204);
    const afterRelease = (await call('GET', `/availability?quote_id=${q.quote_id}&from=${from}&to=${to}`)).body;
    assert.ok(afterRelease.slots.some((s) => s.start === slot.start && s.team.id === slot.team.id));
  });

  test('a forged slot token is refused', async () => {
    const q = (await call('POST', '/quote', quoteRequest)).body;
    const forged = `${Buffer.from(JSON.stringify({ q: q.quote_id, d: '2030-01-01', s: 540, e: 690, c: 1 })).toString('base64url')}.AAAAAAAAAAAAAAAAAAAAAA`;
    const res = await call('POST', '/holds', { slot_token: forged, placed_by: { kind: 'sales_rep', id: 'r1' } });
    assert.deepEqual([res.status, res.body.error.code], [400, 'invalid_request']);
  });

  test('with writes off, booking is refused and nothing reaches Launch27', async () => {
    const off = createPlacement({ db, config: { ...config, allowWrites: false }, fetchImpl: mock, schedule, writes, log: quiet });
    const q = await off.quote(quoteRequest, 'sales-hub');
    const from = off._addDays(off._today(), 1);
    const { slots } = await off.availability({ quote_id: q.quote_id, from, to: off._addDays(from, 6) });
    const h = await off.hold({ slot_token: slots.at(-1).slot_token, placed_by: { kind: 'system', id: 't' } });
    await assert.rejects(() => off.book({ hold_id: h.hold_id, customer, answers, placed_by: { kind: 'system', id: 't' } }, 'writes-off-key-1', 'sales-hub'), (e) => e.code === 'forbidden');
    const blocked = (await writes.list()).rows.filter((r) => r.source === 'placement' && r.outcome === 'blocked');
    assert.equal(blocked.length, 1);
    // The key was freed, so the same request can be retried once writes are on.
    assert.equal((await db.query("SELECT count(*)::int AS n FROM placement_bookings WHERE key = 'sales-hub:writes-off-key-1'")).rows[0].n, 0);
    await off.release(h.hold_id);
  });

  test('every answer matched the contract, and nothing failed on our side', () => {
    assert.deepEqual(problems, []);
  });

  test('without PLACEMENT_TOKENS the API is not served', async () => {
    const plain = createApp(loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' }), { db, fetchImpl: mock, placement, schedule, log: quiet }).listen(0);
    await new Promise((r) => plain.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${plain.address().port}/api/placement/v1/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.notEqual(res.status, 200);
    plain.closeAllConnections();
    plain.close();
  });
});
