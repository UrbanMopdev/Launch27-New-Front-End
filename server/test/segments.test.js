import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classify, slimBooking, suggestion, monthEnds, validateSegmentSettings, DEFAULT_SEGMENT_SETTINGS } from '../src/segments/rules.js';
import { createSegments } from '../src/segments/service.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';

const NOW = Date.parse('2026-11-01T15:00:00Z'); // Nov 1 2026, 11 am Toronto
const TODAY = '2026-11-01';

let nextId = 1000;
// A Launch27 booking as the API returns it (service at 2 pm Toronto).
function bk(cid, day, freq, total = 200, { created, vip = false, name } = {}) {
  return {
    id: nextId++,
    service_date: `${day}T18:00:00Z`,
    created_at: `${created || new Date(Date.parse(`${day}T12:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`,
    frequency: { id: 1, name: freq },
    phone: `(613) 555-01${String(cid).padStart(2, '0')}`,
    address: { city: 'Ottawa' },
    summary: { total },
    user: { id: cid, name: name || `Customer ${cid}`, email: `c${cid}@example.com`, tags_info: vip ? [{ id: 1, name: 'VIP' }] : [] },
  };
}

function fixture() {
  nextId = 1000;
  const B = 'Biweekly - 10% off';
  const W = 'Weekly - 15% off';
  const O = 'One time';
  const active = [
    // 1 recurring for over a year
    bk(1, '2025-09-02', B), bk(1, '2026-10-20', B), bk(1, '2026-11-03', B), bk(1, '2026-11-17', B),
    // 2 at risk: weekly, last clean Oct 10, nothing booked
    bk(2, '2026-09-26', W), bk(2, '2026-10-03', W), bk(2, '2026-10-10', W, 300),
    // 3 lapsed recurring: monthly until June
    bk(3, '2026-04-15', 'Monthly - 5% off'), bk(3, '2026-06-15', 'Monthly - 5% off'),
    // 4 repeat one-time
    bk(4, '2026-07-10', O), bk(4, '2026-10-12', O),
    // 5 first-time, recent
    bk(5, '2026-10-20', O),
    // 6 first visit coming up
    bk(6, '2026-11-05', O, 250, { created: '2026-10-29' }),
    // 7 lapsed one-time
    bk(7, '2026-02-03', O),
    // 8 converted to prepaid, VIP
    bk(8, '2026-06-01', O, 220, { vip: true }), bk(8, '2026-10-17', 'Prepaid Biweekly', 180, { vip: true }), bk(8, '2026-11-14', 'Prepaid Biweekly', 180, { vip: true }),
    // 9 recurring with a cancellation
    bk(9, '2026-10-25', B), bk(9, '2026-11-08', B),
  ];
  const cancelled = [bk(9, '2026-10-11', B)];
  return { active, cancelled };
}

// Stand-in Launch27: bookings by date range / customer, paged; count; login; customers/count.
function fakeLaunch27(data) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || 'GET'} ${u.pathname}`);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/latest/login') return json({ bearer: 'sync-bearer' });
    if (u.pathname === '/v1/staff/customers/count') return json({ count: 25 });
    const q = u.searchParams;
    const inRange = (b) => {
      const d = b.service_date.slice(0, 10);
      return (!q.get('from') || d >= q.get('from')) && (!q.get('to') || d <= q.get('to')) && (!q.get('customers') || String(b.user.id) === q.get('customers'));
    };
    if (u.pathname === '/v1/staff/bookings/count') return json({ count: (q.get('filter') === 'cancelled' ? data.cancelled : data.active).filter(inRange).length });
    if (u.pathname === '/v1/staff/bookings' && (init.method || 'GET') === 'GET') {
      const list = (q.get('filter') === 'cancelled' ? data.cancelled : data.active).filter(inRange);
      const off = Number(q.get('offset') || 0);
      return json(list.slice(off, off + Number(q.get('limit') || 100)));
    }
    if (u.pathname === '/v1/staff/bookings' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const b = bk(body.customer_id, body.day, body.freq);
      data.active.push(b);
      return json(b, 201);
    }
    return json({ error: 'not found' }, 404);
  };
  return { fetchImpl, calls };
}

const slimAll = (list) => list.map(slimBooking);
const forCustomer = (data, cid) => slimAll(data.active.filter((b) => b.user.id === cid));
const quiet = { info() {}, warn() {}, error() {} };

describe('segments: rules', () => {
  const data = fixture();
  const seg = (cid, opts) => classify(forCustomer(data, cid), TODAY, opts);

  test('each customer lands in exactly the segment the rules say', () => {
    assert.equal(seg(1).segment, 'recurring');
    assert.equal(seg(2).segment, 'risk');
    assert.equal(seg(3).segment, 'lapsedRec');
    assert.equal(seg(4).segment, 'repeat');
    assert.equal(seg(5).segment, 'first');
    assert.equal(seg(6).segment, 'first');
    assert.equal(seg(7).segment, 'lapsedOne');
    assert.equal(seg(8).segment, 'recurring');
  });

  test('traits stack: prepaid, converted, new on a plan, VIP, cancelled', () => {
    assert.deepEqual(seg(8).traits.sort(), ['converted', 'newplan', 'prepaid', 'vip']);
    assert.deepEqual(seg(1).traits, []);
    assert.ok(seg(9, { cancelled: 1 }).traits.includes('cancelled'));
    assert.equal(seg(8).last_prepaid, '2026-11-14');
  });

  test('metrics: last and next clean, 12-month spend, plan', () => {
    const r = seg(2);
    assert.equal(r.last_clean, '2026-10-10');
    assert.equal(r.next_clean, null);
    assert.equal(r.spend_12m, 700);
    assert.equal(r.plan, W());
    function W() { return 'Weekly - 15% off'; }
  });

  test('cut-offs come from settings', () => {
    assert.equal(seg(2, { settings: { ...DEFAULT_SEGMENT_SETTINGS, risk_days: 14 } }).segment, 'lapsedRec');
    assert.equal(seg(5, { settings: { ...DEFAULT_SEGMENT_SETTINGS, first_days: 10 } }).segment, 'lapsedOne');
    assert.throws(() => validateSegmentSettings({ risk_days: 3 }), /between 7 and 730/);
    assert.equal(validateSegmentSettings({ risk_days: '30' }).risk_days, 30);
  });

  test('rebuilding history only counts bookings that existed then', () => {
    // On Oct 28 customer 6 had not booked yet.
    assert.equal(classify(forCustomer(data, 6), '2026-10-28', { known: true }).segment, 'lapsedOne');
    assert.equal(classify(forCustomer(data, 6), '2026-10-30', { known: true }).segment, 'first');
  });

  test('suggestions and days left', () => {
    const risk = { ...seg(2), segment: 'risk' };
    const s = suggestion(risk, TODAY);
    assert.equal(s.days_left, 45 - 22);
    assert.match(s.text, /22 days/);
    assert.match(suggestion({ ...seg(8) }, TODAY).text, /Last prepaid visit on the schedule is Nov 14/);
    assert.match(suggestion(seg(6), TODAY).text, /First visit Nov 5/);
  });

  test('month ends before today', () => {
    const ends = monthEnds(TODAY, 12);
    assert.equal(ends.length, 12);
    assert.equal(ends[0], '2025-11-30');
    assert.equal(ends.at(-1), '2026-10-31');
  });
});

describe('segments: sync, store, read', () => {
  test('first sync stores segments, rebuilds the past year and answers the screens', async () => {
    const data = fixture();
    const { fetchImpl, calls } = fakeLaunch27(data);
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const seg = createSegments({ db, config, fetchImpl, log: quiet, now: () => NOW });

    const run = await seg.sync({ trigger: 'boot' });
    assert.equal(run.status, 'done');
    assert.equal(run.customers, 9);
    assert.ok(calls.every((c) => c.startsWith('GET ') || c === 'POST /latest/login'), 'the sync only reads');

    const sum = await seg.summary({ bearer: 'b' });
    const count = (id) => sum.segments.find((s) => s.id === id).count;
    assert.equal(count('recurring'), 3);
    assert.equal(count('risk'), 1);
    assert.equal(count('first'), 2);
    assert.equal(sum.traits.find((t) => t.id === 'prepaid').count, 1);
    assert.equal(sum.traits.find((t) => t.id === 'cancelled').count, 1);
    assert.equal(sum.no_recent, 25 - 9);
    assert.ok(sum.updated_at);
    assert.ok(Math.abs(sum.segments.reduce((s, x) => s + x.revenue_share, 0) - 1) < 1e-9);

    // Past year rebuilt as month ends, marked estimated.
    const days = (await db.query('SELECT DISTINCT day, estimated FROM segment_daily ORDER BY day')).rows;
    assert.equal(days.length, 13);
    assert.ok(days.slice(0, 12).every((d) => d.estimated) && !days[12].estimated);

    // Lists: filtered, sorted for the job, searchable.
    const risk = await seg.customers({ segment: 'risk' });
    assert.equal(risk.total, 1);
    assert.equal(risk.rows[0].name, 'Customer 2');
    assert.equal(risk.rows[0].days_left, 23);
    const prepaid = await seg.customers({ traits: ['prepaid'] });
    assert.deepEqual(prepaid.rows.map((r) => r.customer_id), [8]);
    assert.equal((await seg.customers({ q: '555-0104' })).rows[0].customer_id, 4);
    assert.equal((await seg.customers({ q: 'customer 7' })).rows[0].segment, 'lapsedOne');

    // Profile: journey history.
    const c8 = await seg.customer(8);
    assert.equal(c8.segment, 'recurring');
    assert.ok(c8.history.length >= 1);
    assert.ok(c8.history.some((h) => h.to_segment === 'recurring'));

    // Trends balance: start + joined - left = end.
    const tr = await seg.trends({ period: '12m' });
    assert.equal(tr.series.at(-1).recurring, 3);
    assert.equal(tr.flow.start + tr.flow.new + tr.flow.converted + tr.flow.won_back - tr.flow.left, tr.flow.end);
    assert.ok(tr.moves.length > 0);
    assert.equal(tr.estimated_until, '2026-10-31');

    // A second run the same day records no new changes.
    const again = await seg.sync({ trigger: 'manual' });
    assert.equal(again.changes, 0);
  });

  test('outcomes, snoozes and segment stats', async () => {
    const data = fixture();
    const { fetchImpl } = fakeLaunch27(data);
    const db = await openDb();
    const seg = createSegments({ db, config: loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' }), fetchImpl, log: quiet, now: () => NOW });
    await seg.sync();
    let stats = await seg.segmentStats('risk');
    assert.equal(stats.customers, 1);
    assert.equal(stats.not_contacted, 1);
    await seg.logOutcome(2, { outcome: 'price', note: 'Found cheaper' }, null);
    stats = await seg.segmentStats('risk');
    assert.equal(stats.not_contacted, 0);
    assert.equal(stats.top_reason, 'price');
    await seg.logOutcome(2, { outcome: 'snoozed', snooze_days: 7 }, null);
    assert.equal((await seg.customers({ segment: 'risk' })).rows[0].snoozed_until, '2026-11-08');
    await assert.rejects(() => seg.logOutcome(2, { outcome: 'whatever' }, null), /outcome must be one of/);
    await assert.rejects(() => seg.saveSettings({ risk_days: 1000 }), /between 7 and 730/);
    assert.equal((await seg.saveSettings({ risk_days: 30 })).risk_days, 30);
  });

  test('a booking made in this app recalculates that customer right away', async () => {
    const data = fixture();
    const { fetchImpl } = fakeLaunch27(data);
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const segments = createSegments({ db, config, fetchImpl, log: quiet, now: () => NOW });
    await segments.sync();
    assert.equal((await segments.customer(2)).segment, 'risk');

    const server = createApp(config, { db, fetchImpl, segments, log: createLogger({ level: 'error' }) }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'staff@example.com', password: 'demo' }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const res = await fetch(`${base}/l27/v1/staff/bookings`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ customer_id: 2, day: '2026-11-07', freq: 'Weekly - 15% off' }) });
      assert.equal(res.status, 201);
      let row;
      for (let i = 0; i < 50; i++) {
        row = await segments.customer(2);
        if (row.segment === 'recurring') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(row.segment, 'recurring');
      assert.ok(row.history.some((h) => h.from_segment === 'risk' && h.to_segment === 'recurring' && !h.estimated));

      // The API serves it to signed-in staff.
      const sum = await (await fetch(`${base}/api/segments/summary`, { headers: { cookie } })).json();
      assert.equal(sum.segments.find((s) => s.id === 'recurring').count, 4);
      const list = await (await fetch(`${base}/api/segments/customers?segment=recurring`, { headers: { cookie } })).json();
      assert.equal(list.total, 4);
    } finally {
      server.close();
    }
  });

  test('production needs its own read-only login for the nightly update', async () => {
    const db = await openDb();
    const warnings = [];
    const config = loadConfig({ APP_ENV: 'production', NODE_ENV: 'production', L27_MODE: 'live' });
    const seg = createSegments({ db, config, fetchImpl: async () => { throw new Error('should not call Launch27'); }, log: { ...quiet, warn: (m) => warnings.push(m) }, now: () => NOW });
    await seg.maybeRun();
    assert.match(warnings[0], /L27_SYNC_EMAIL/);
    assert.equal(seg.isRunning(), false);
    assert.equal(loadConfig({ APP_ENV: 'staging', L27_MODE: 'mock', MOCK_PASSWORD: 'x', L27_SYNC_EMAIL: 'a@b.c' }).l27SyncEmail, null, 'dev and QA never use a live sync login');
  });
});
