import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { slimReportVisit, timing, indexVisits, mainBefore, sameCleaner, cleanerStats, flagsFor, cleanerRow, regularClients, cleanName } from '../src/reports/compute.js';
import { createReports } from '../src/reports/service.js';
import { createSchedule } from '../src/schedule/service.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };
let id = 1;
// A visit at 9am Toronto on `date` with cleaner `team`; checkin `lateMin` after the 60-min window.
function V(date, cust, team, { kind = 'Biweekly - 10% off', lateMin = 0, onsite = 180, rating = null, earned = 66, km = null } = {}) {
  const start = Date.parse(`${date}T14:00:00Z`);
  const checkin = new Date(start + (lateMin ? 60 + lateMin : 20) * 60_000).toISOString();
  const checkout = new Date(Date.parse(checkin) + onsite * 60_000).toISOString();
  const booking = { id: id++, service_date: `${date}T14:00:00Z`, arrival_window: 60, duration: 180, frequency: { name: kind }, user: { id: cust, name: `Client ${cust}` }, summary: { revenue: 200 }, teams: [{ id: team, title: `(1)(F)Cleaner ${team}`, hours: 3 }] };
  const tt = { id: booking.id, teams: [{ id: team, earned, time_tracking: { checkin_at: checkin, checkout_at: checkout, enroute_started_at: km != null ? checkin : null, distance: km } }] };
  const fb = rating == null ? null : { feedback: { rating, comment: rating === 0 ? 'Missed spots' : 'Great', rated_at: checkout } };
  return slimReportVisit(booking, tt, fb);
}

describe('reports: per-visit timing and main cleaner', () => {
  test('on time, late, ran long, title codes stripped', () => {
    const v = V('2026-10-05', 1, 7, { lateMin: 30, onsite: 230 });
    assert.equal(v.teams[0].name, 'Cleaner 7');
    const t = timing(v, v.teams[0]);
    assert.equal(t.onTime, false);
    assert.equal(t.late, 30);
    assert.equal(t.long, true);
    assert.equal(timing(V('2026-10-05', 1, 7), V('2026-10-05', 1, 7).teams[0]).onTime, true);
    assert.equal(cleanName('ON HOLD(2)(F)Nicole T'), 'Nicole T');
  });
  test('main cleaner = most of the previous 6 visits; same-cleaner share by week', () => {
    const visits = [V('2026-08-03', 1, 7), V('2026-08-17', 1, 7), V('2026-08-31', 1, 7), V('2026-09-14', 1, 8), V('2026-09-28', 1, 7), V('2026-10-12', 1, 8)];
    const idx = indexVisits(visits);
    assert.equal(mainBefore(idx.get(1), Date.parse('2026-10-01T00:00:00Z')), 7);
    const sc = sameCleaner(visits, idx, '2026-08-01', '2026-10-31');
    // First visit has no history; of the other 5, main (7) did 3.
    assert.equal(sc.visits, 5);
    assert.equal(Math.round(sc.share * 100), 60);
    assert.equal(sc.series.length, 5);
  });
});

describe('reports: cleaner stats and flags', () => {
  test('keeps clients, ratings, late flags, earnings', () => {
    const today = '2026-11-02';
    const visits = [];
    // Cleaner 7 has clients 1..5 before the period; keeps 1 and 2, loses 3,4,5 to cleaner 8.
    for (let c = 1; c <= 5; c++) for (const d of ['2026-06-01', '2026-06-15', '2026-07-06']) visits.push(V(d, c, 7));
    for (const c of [1, 2]) for (const d of ['2026-09-07', '2026-09-21', '2026-10-05', '2026-10-19']) visits.push(V(d, c, 7, { lateMin: c === 1 ? 25 : 0, rating: c === 1 ? 0 : 2 }));
    for (const c of [3, 4, 5]) for (const d of ['2026-09-08', '2026-09-22', '2026-10-06', '2026-10-20']) visits.push(V(d, c, 8));
    const idx = indexVisits(visits);
    const stats = cleanerStats(visits, idx, '2026-08-03', '2026-11-01', today);
    const s7 = stats.get(7);
    assert.equal(s7.started, 5);
    assert.equal(s7.kept, 2);
    const row = cleanerRow(s7);
    assert.equal(row.visits, 8);
    assert.equal(row.on_time, 0.5);
    assert.equal(row.unhappy, 4);
    assert.equal(row.earned, 8 * 66);
    assert.equal(row.keeps, 0.4);
    const flags = flagsFor(s7, { booked: 10, capacity: 40 }).map((f) => f.kind).sort();
    assert.deepEqual(flags, ['late', 'losing', 'ratings', 'underbooked']);
    const regs = regularClients(8, idx, Date.parse('2026-11-01T00:00:00Z'));
    assert.deepEqual(regs.map((r) => r.customer_id).sort(), [3, 4, 5]);
  });
});

describe('reports: service on the sample Launch27', () => {
  test('builds, reports, and shows pay to admins only', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await assert.rejects(() => reports.scheduling('13w'), /not been built yet/);
    await schedule.sync();
    await reports.sync();
    const sc = await reports.scheduling('13w');
    assert.ok(sc.kpis.on_time > 0.5 && sc.kpis.on_time <= 1);
    assert.ok(sc.kpis.same_cleaner_visits > 0);
    assert.ok(sc.same_cleaner_series.length >= 12);
    assert.ok(sc.areas.length > 0);
    assert.equal(typeof sc.planner.raised, 'number');
    const asAgent = await reports.cleaners('13w', { admin: false });
    assert.ok(asAgent.rows.length > 0);
    assert.ok(asAgent.rows.every((r) => r.earned === undefined) && asAgent.team.earned === undefined);
    const asAdmin = await reports.cleaners('13w', { admin: true });
    assert.ok(asAdmin.rows.some((r) => r.earned > 0));
    const one = await reports.cleaner(asAdmin.rows[0].id, '13w', { admin: false });
    assert.equal(one.stats.earned, undefined);
    assert.equal(one.last40.length, 40);
    assert.ok(one.series.length >= 13);
    // Brand switcher: Commercial (Commercial Ottawa 167 + Cornwall 168) is a slice of the whole.
    const com = await reports.cleaners('13w', { admin: true, locations: [167, 168] });
    const res = await reports.cleaners('13w', { admin: true, locations: [1, 2, 3] });
    const visits = (r) => r.rows.reduce((a, x) => a + (x.visits || 0), 0);
    assert.ok(visits(com) > 0 && visits(res) > visits(com));
    assert.ok(com.rows.length < asAdmin.rows.length, 'only cleaners working in that brand');
    const comSched = await reports.scheduling('13w', { locations: [167, 168] });
    assert.ok(comSched.kpis.same_cleaner_visits < sc.kpis.same_cleaner_visits);
  });
});
