import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { headroomFacts, headroomReport, statusOf } from '../src/reports/headroom.js';
import { HEADROOM } from '../src/reports/headroom-config.js';
import { createReports } from '../src/reports/service.js';
import { createSchedule } from '../src/schedule/service.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { openDb } from '../src/db/index.js';
import { loadConfig, canSeeHeadroom } from '../src/config.js';
import { createApp } from '../src/app.js';

const quiet = { info() {}, warn() {}, error() {} };
const HOME = { lat: 45.4215, lng: -75.6972 }; // downtown: Central
const week = (start = '09:00', end = '17:00') => [0, 1, 2, 3, 4, 5, 6].map((d) => ({ id: d, date: null, weekday: d, dayoff: false, start_time: start, end_time: end }));
const visit = (key, date, start, end, team, over = {}) => ({ key, date, start, end, duration: end - start, team_ids: team, team_hours: {}, location_id: 1, customer_id: 100, kind: 'weekly', ...HOME, ...over });

// Monday Nov 9 to Sunday Nov 15, 2026; cleaners work 9 to 5 every day, Sunday included.
const TODAY = '2026-11-09';
const A = { id: 1, name: 'A', area: 'Central', assignable: true, location_ids: [1], ...HOME, rules: {}, availability: [...week(), { id: 99, date: '2026-11-12', weekday: null, dayoff: false, start_time: '09:00', end_time: '13:00' }] };
const B = { id: 2, name: 'B', area: 'Central', assignable: true, location_ids: [1, 2], ...HOME, rules: {}, availability: week() };
const OFF = { id: 3, name: 'On hold', area: 'Central', assignable: false, location_ids: [1], ...HOME, rules: {}, availability: week() };
const VISITS = [
  visit('v1', '2026-11-09', 540, 720, [1, 2], { team_hours: { 1: 3, 2: 3 } }), // two cleaners, Monday 9–12
  visit('v2', '2026-11-15', 600, 720, [1]), // Sunday: left out
  visit('v3', '2026-11-10', 600, 720, [], { customer_id: 101, kind: 'one' }), // unassigned, Tuesday
  visit('v4', '2026-11-15', 600, 720, []), // unassigned Sunday: left out
  visit('v5', '2026-11-11', 540, 720, [2], { location_id: 2, customer_id: 102 }), // B, the other brand
  visit('v6', '2026-11-13', 780, 960, [1]), // A, Friday 1–4pm: leaves a 54-min fragment before 5
  visit('v7', '2026-11-14', 600, 660, [3]), // on a cleaner not taking bookings
];
const HOLIDAYS = [{ date: '2026-11-12', start_time: '00:00', end_time: '23:59', location_id: 1 }];
const facts = (locations = null) => headroomFacts({ today: TODAY, cleaners: [A, B, OFF], visits: VISITS, holidays: HOLIDAYS, locations, until: '2026-11-15' });

describe('headroom: the arithmetic, by hand', () => {
  test('raw headroom = availability − assigned − unassigned − on cleaners not taking bookings; Sundays out', () => {
    const r = headroomReport({ facts: facts(), weeks: 1, cleaners: [A, B, OFF] });
    // A: 5 days × 8h + Thursday's own 4h (closed date, but A set hours that day) = 44. B: 5 × 8, Thursday closed = 40.
    assert.equal(r.totals.available_h, 84);
    assert.equal(r.totals.closed_h, 8);
    // v1 counts against both cleaners (3 + 3), v5 3h, v6 3h. Sunday v2 is left out.
    assert.equal(r.totals.assigned_h, 12);
    assert.equal(r.totals.unassigned_h, 2);
    assert.equal(r.totals.unassigned_visits, 1);
    assert.equal(r.totals.not_taking_h, 1);
    assert.equal(r.totals.raw_h, 84 - 12 - 2 - 1);
    assert.equal(r.totals.raw_pct, 69 / 84);
  });

  test('adjusted: route travel (home → visits → home) and fragments under 2.5h', () => {
    const r = headroomReport({ facts: facts(), weeks: 1, cleaners: [A, B, OFF] });
    // Every stop is at home: each leg is the 6-minute minimum. 4 cleaner-days × (out + home) = 48 min,
    // plus one average leg (6) for the unassigned visit and one for the visit on the on-hold cleaner.
    assert.equal(r.totals.travel_h, 1);
    // Friday: A is busy 12:54–4:06pm; 4:06–5pm (54 min) is too short for a booking.
    assert.equal(r.totals.fragments_h, 0.9);
    assert.equal(r.totals.adjusted_h, 69 - 1 - 0.9);
  });

  test('brand view: the shared cleaner loses the hours booked for the other brand', () => {
    const r = headroomReport({ facts: facts([1]), weeks: 1, cleaners: [A, B, OFF] });
    assert.equal(r.totals.available_h, 81); // B's Wednesday 9–12 went to the other brand
    assert.equal(r.totals.assigned_h, 9);
    assert.equal(r.ratio.customers, 2);
  });

  test('ratio, areas, key-person risk', () => {
    const r = headroomReport({ facts: facts(), weeks: 1, cleaners: [A, B, OFF] });
    assert.deepEqual([r.ratio.cleaners, r.ratio.customers, r.ratio.customers_recurring], [2, 3, 2]);
    const central = r.areas.find((a) => a.area === 'Central');
    assert.equal(central.cleaners, 2);
    assert.equal(central.adjusted_h, r.totals.adjusted_h);
    const a = r.cleaners.find((c) => c.cleaner_id === 1);
    assert.equal(a.assigned_h, 6);
    assert.ok(Math.abs(a.if_left - 6 / (69 - 1 - 0.9)) < 0.01);
    assert.equal(r.cleaners[0].cleaner_id, 1); // most assigned hours = highest risk, sorted first
  });

  test('status thresholds come from the config', () => {
    assert.equal(statusOf(HEADROOM.redAt), 'red');
    assert.equal(statusOf(HEADROOM.redAt + 0.01), 'amber');
    assert.equal(statusOf(0.5), 'green');
    assert.equal(statusOf(null), null);
  });
});

describe('headroom: on the sample Launch27', () => {
  test('reconciles with Scheduling insights for every window and brand; nothing on a Sunday', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    for (const locations of [null, [1], [167, 168]]) {
      for (const weeks of [1, 2, 4, 8]) {
        const r = await reports.headroom(weeks, { locations });
        const label = `${weeks}w ${locations || 'both'}`;
        assert.ok(r.reconcile.capacity.ties, `capacity ${label}`);
        assert.ok(r.reconcile.booked.ties, `booked ${label}`);
        assert.ok(r.reconcile.unassigned.ties, `unassigned ${label}`);
        assert.equal(r.trend.length, 8);
        const t = r.totals;
        assert.ok(Math.abs(t.raw_h - (t.available_h - t.assigned_h - t.unassigned_h - t.not_taking_h)) < 0.2, label);
      }
    }
    const src = await schedule.headroomSource();
    assert.ok(src.holidays.some((h) => h.date.endsWith('-12-25')), 'closed dates are read');
    await db.close();
  });

  test('everyone sees it outside production; HEADROOM_EMAILS can narrow it; never in production', async () => {
    assert.equal(canSeeHeadroom(loadConfig({ APP_ENV: 'production', DATABASE_URL: 'x', SESSION_SECRET: 'x'.repeat(40) }), 'boss@example.com'), false);
    assert.equal(canSeeHeadroom(loadConfig({ APP_ENV: 'development', HEADROOM_EMAILS: 'Boss@Example.com' }), 'someone@example.com'), false);
    assert.equal(canSeeHeadroom(loadConfig({ APP_ENV: 'development', HEADROOM_EMAILS: 'Boss@Example.com' }), 'boss@example.com'), true);
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    const server = createApp(config, { fetchImpl, db, schedule, reports }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const email of ['boss@example.com', 'someone@example.com']) {
        const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo' }) });
        const cookie = res.headers.get('set-cookie').split(';')[0];
        const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
        assert.equal(me.features.headroom, true, email);
        const hr = await fetch(`${base}/api/reports/headroom?weeks=2`, { headers: { cookie } });
        assert.equal(hr.status, 200, email);
        assert.equal((await hr.json()).weeks, 2);
      }
    } finally {
      server.close();
      await db.close();
    }
  });
});
