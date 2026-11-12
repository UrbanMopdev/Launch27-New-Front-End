import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { utilizationFacts, utilizationReport, clampRange, dataCheck } from '../src/reports/utilization.js';
import { createReports } from '../src/reports/service.js';
import { createSchedule } from '../src/schedule/service.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { openDb } from '../src/db/index.js';
import { loadConfig, canSeeUtilization } from '../src/config.js';
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
  visit('v6', '2026-11-13', 780, 960, [1]), // A, Friday 1–4pm
  visit('v7', '2026-11-14', 600, 660, [3]), // on a cleaner not taking bookings
];
const HOLIDAYS = [{ date: '2026-11-12', start_time: '00:00', end_time: '23:59', location_id: 1 }];
const facts = (locations = null) => utilizationFacts({ today: TODAY, cleaners: [A, B, OFF], visits: VISITS, holidays: HOLIDAYS, locations, until: '2026-11-15' });

const report = (locations = null) => utilizationReport({ facts: facts(locations), from: TODAY, to: '2026-11-15', maxTo: '2026-11-15' });

describe('utilization: the arithmetic, by hand', () => {
  test('available − assigned − unassigned − not taking − travel = left; Sundays out', () => {
    const t = report().totals;
    // A: 5 days × 8h + Thursday's own 4h (closed date, but A set hours that day) = 44. B: 5 × 8, Thursday closed = 40.
    assert.equal(t.available_h, 84);
    assert.equal(t.closed_h, 8);
    // v1 counts against both cleaners (3 + 3), v5 3h, v6 3h. Sunday v2 is left out.
    assert.equal(t.assigned_h, 12);
    assert.equal(t.unassigned_h, 2);
    assert.equal(t.unassigned_visits, 1);
    assert.equal(t.not_taking_h, 1);
    // Every stop is at home, so each leg is the 6-minute minimum: 4 cleaner-days × (out + home) = 48 min,
    // plus one average leg (6) each for the unassigned visit and the one on the on-hold cleaner.
    assert.equal(t.travel_h, 1);
    assert.equal(t.spoken_h, 16);
    assert.equal(t.left_h, 68);
    assert.equal(t.utilization, 16 / 84);
    // Typical booking 3h (12h over 4 cleaner-visits) + a 6-min leg = 3.1h each: 68 ÷ 3.1 → 21.
    assert.equal(t.typical_booking_h, 3);
    assert.equal(t.room_bookings, 21);
  });

  test('brand view: the shared cleaner loses the hours booked for the other brand', () => {
    const t = report([1]).totals;
    assert.equal(t.available_h, 81); // B's Wednesday 9–12 went to the other brand
    assert.equal(t.assigned_h, 9);
    assert.equal(t.travel_h, 0.8); // B's Wednesday route is the other brand's
    assert.equal(t.customers, 2);
  });

  test('by cleaner, by area, by day', () => {
    const r = report();
    const a = r.cleaners.find((c) => c.cleaner_id === 1);
    assert.deepEqual([a.available_h, a.assigned_h, a.travel_h, a.left_h, a.visits], [44, 6, 0.4, 37.6, 2]);
    assert.ok(Math.abs(a.if_left - 6.4 / 68) < 1e-9);
    assert.equal(r.areas.find((x) => x.area === 'Central').left_h, 68);
    assert.deepEqual(r.by_day.map((d) => d.date), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    const mon = r.by_day[0];
    assert.deepEqual([mon.available_h, mon.spoken_h, mon.left_h], [16, 6.4, 9.6]);
    assert.equal(mon.areas.Central.left_h, 9.6);
  });

  test('any date range, kept within today … the end of the planner copy', () => {
    assert.deepEqual(clampRange('2026-11-09', '2026-11-12', '2026-11-12', '2027-01-03'), { from: '2026-11-12', to: '2026-11-12' });
    assert.deepEqual(clampRange('2026-11-09', '2026-11-01', '2027-02-01', '2027-01-03'), { from: '2026-11-09', to: '2027-01-03' });
    assert.deepEqual(clampRange('2026-11-09', 'junk', null, '2027-01-03'), { from: '2026-11-09', to: '2026-11-15' });
    assert.deepEqual(clampRange('2026-11-09', '2026-11-20', '2026-11-10', '2027-01-03'), { from: '2026-11-20', to: '2026-11-20' });
    const one = utilizationReport({ facts: facts(), from: '2026-11-13', to: '2026-11-13', maxTo: '2026-11-15' }).totals;
    assert.deepEqual([one.available_h, one.assigned_h], [16, 3]);
  });
});

describe('utilization: on the sample Launch27', () => {
  test('ties to Scheduling insights for any dates and brand; nothing on a Sunday', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    const src = await schedule.utilizationSource();
    const t0 = src.today;
    const add = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    for (const locations of [null, [1], [167, 168]]) {
      for (const [from, to] of [[t0, add(t0, 6)], [add(t0, 3), add(t0, 3)], [t0, add(t0, 55)], [add(t0, 10), add(t0, 24)]]) {
        const r = await reports.utilization({ from, to, locations });
        const label = `${from}..${to} ${locations || 'both'}`;
        assert.ok(r.reconcile.capacity.ties, `capacity ${label}`);
        assert.ok(r.reconcile.booked.ties, `booked ${label}`);
        assert.ok(r.reconcile.unassigned.ties, `unassigned ${label}`);
        const t = r.totals;
        assert.ok(Math.abs(t.left_h - (t.available_h - t.assigned_h - t.unassigned_h - t.not_taking_h - t.travel_h)) < 0.3, label);
        assert.ok(r.by_day.every((d) => new Date(`${d.date}T12:00:00Z`).getUTCDay() !== 0), `no Sundays ${label}`);
      }
    }
    assert.ok(src.holidays.some((h) => h.date.endsWith('-12-25')), 'closed dates are read');
    await db.close();
  });

  test('everyone sees it, production included; UTILIZATION_EMAILS can narrow it', async () => {
    assert.equal(canSeeUtilization(loadConfig({ APP_ENV: 'production', DATABASE_URL: 'x', SESSION_SECRET: 'x'.repeat(40) }), 'boss@example.com'), true);
    assert.equal(canSeeUtilization(loadConfig({ APP_ENV: 'production', UTILIZATION_EMAILS: 'boss@example.com', DATABASE_URL: 'x', SESSION_SECRET: 'x'.repeat(40) }), 'someone@example.com'), false);
    assert.equal(canSeeUtilization(loadConfig({ APP_ENV: 'development', UTILIZATION_EMAILS: 'Boss@Example.com' }), 'someone@example.com'), false);
    assert.equal(canSeeUtilization(loadConfig({ APP_ENV: 'development', UTILIZATION_EMAILS: 'Boss@Example.com' }), 'boss@example.com'), true);
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
        assert.equal(me.features.utilization, true, email);
        const ut = await fetch(`${base}/api/reports/utilization`, { headers: { cookie } });
        assert.equal(ut.status, 200, email);
        const body = await ut.json();
        assert.equal(body.from, body.today); // default: the next 7 days
      }
    } finally {
      server.close();
      await db.close();
    }
  });
});

describe('utilization: data check', () => {
  test('flags refused hours, booked with no hours, booked while not taking, no hours set, no home location', () => {
    const NOHOURS = { id: 4, name: 'No hours', area: 'Unknown', assignable: true, location_ids: [1], lat: null, lng: null, rules: {}, availability: [] };
    const REFUSED = { ...NOHOURS, id: 5, name: 'Refused', ...HOME, area: 'Central', availability_error: 'Launch27 refused: not allowed for this login (403)' };
    const visits = [...VISITS, visit('v8', '2026-11-10', 600, 720, [4]), visit('v9', '2026-11-11', 600, 720, [5])];
    const all = [A, B, OFF, NOHOURS, REFUSED].map((c) => ({ ...c, weekly_hours: c.availability.length ? 8 * 7 : 0, status_label: c.assignable ? 'Active' : 'On hold' }));
    const f = utilizationFacts({ today: TODAY, cleaners: all, visits, holidays: HOLIDAYS, until: '2026-11-15' });
    const dc = dataCheck({ facts: f, inWin: (d) => d >= TODAY && d <= '2026-11-15', cleaners: all, source: { full_at: '2026-11-09T10:00:00Z', cleaners_by: 'person' } });
    const kinds = (id) => dc.cleaners.find((c) => c.cleaner_id === id).flags.map((x) => x.kind);
    assert.deepEqual(kinds(5), ['refused', 'booked_no_hours']);
    assert.deepEqual(kinds(4), ['booked_no_hours', 'no_hours', 'no_home']);
    assert.deepEqual(kinds(3), ['booked_not_taking']);
    assert.deepEqual(kinds(1), []);
    assert.equal(dc.cleaners[0].cleaner_id, 5); // problems first, refused at the top
    assert.equal(dc.counts.booked_no_hours, 2);
    assert.equal(dc.read_by, 'person');
  });

  test('the planner records a refusal instead of hiding it, and retries a temporary one', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const mock = createMockLaunch27({ password: 'demo' });
    let tries429 = 0;
    const fetchImpl = async (url, init) => {
      if (url.includes('/v1/staff/teams/9000/availability')) return new Response('{}', { status: 403 });
      if (url.includes('/v1/staff/teams/9001/availability') && tries429++ === 0) return new Response('{}', { status: 429 });
      return mock(url, init);
    };
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet, retryDelayMs: 0 });
    await schedule.sync();
    const src = await schedule.utilizationSource();
    const c0 = src.cleaners.find((c) => c.id === 9000);
    const c1 = src.cleaners.find((c) => c.id === 9001);
    assert.equal(c0.availability_error, 'Launch27 refused: not allowed for this login (403)');
    assert.deepEqual(c0.availability, []);
    assert.equal(c1.availability_error, null); // 429 once, then fine on the retry
    assert.ok(c1.availability.length > 0);
    assert.equal(src.cleaners_by, 'sync');
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    const r = await reports.utilization({});
    assert.ok(r.data_check.cleaners.find((c) => c.cleaner_id === 9000).flags.some((f) => f.kind === 'refused'));
    await db.close();
  });
});

describe('reading Launch27 hours', () => {
  test('times in any common format', async () => {
    const { toMinutes } = await import('../src/schedule/rules.js');
    assert.deepEqual(['09:00', '9:00:00', '9:00 AM', '9am', '5:00 PM', '5pm', '17:30', '12:00 PM', '12:30 AM'].map(toMinutes), [540, 540, 540, 540, 1020, 1020, 1050, 720, 30]);
  });
  test('a date row with no times does not wipe out the weekly hours; split days count; AM/PM read right', async () => {
    const { workingWindow, weeklyHours } = await import('../src/schedule/rules.js');
    const rows = [
      { date: null, weekday: 1, dayoff: false, start_time: '9:00 AM', end_time: '5:00 PM' },
      { date: null, weekday: 2, dayoff: false, start_time: '08:00', end_time: '12:00' },
      { date: null, weekday: 2, dayoff: false, start_time: '13:00', end_time: '17:00' },
      { date: '2026-11-16', weekday: null, dayoff: false, start_time: null, end_time: null }, // Monday, says nothing
      { date: '2026-11-23', weekday: null, dayoff: true, start_time: null, end_time: null }, // Monday off
      { date: '2026-11-30', weekday: null, dayoff: false, start_time: '10:00', end_time: '14:00' }, // short Monday
    ];
    assert.deepEqual(workingWindow(rows, '2026-11-16'), [540, 1020]);
    assert.equal(workingWindow(rows, '2026-11-23'), null);
    assert.deepEqual(workingWindow(rows, '2026-11-30'), [600, 840]);
    assert.deepEqual(workingWindow(rows, '2026-11-17'), [480, 1020]);
    assert.equal(weeklyHours(rows), 8 + 8);
  });
});
test('a split day counts its blocks, not the gap', async () => {
  const { workingMinutes } = await import('../src/schedule/rules.js');
  const rows = [{ date: null, weekday: 2, dayoff: false, start_time: '08:00', end_time: '12:00' }, { date: null, weekday: 2, dayoff: false, start_time: '13:00', end_time: '17:00' }];
  assert.equal(workingMinutes(rows, '2026-11-17'), 480);
});
