import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCleaner, customerPrefs, cycleWeek, cycleWeeks, frequencyKind, fitsDay, rankCleaners, workingWindow, openGaps, mainCleaner, seriesDates } from '../src/schedule/rules.js';
import { createSchedule } from '../src/schedule/service.js';
import { createWriteLog } from '../src/writes.js';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };

describe('schedule: cleaner codes and tags', () => {
  test('status from the title codes', () => {
    const s = (title) => parseCleaner({ id: 1, title });
    assert.equal(s('(1)(F)Jane Doe').status, 'active');
    assert.equal(s('(1)(F)Jane Doe').name, 'Jane Doe');
    assert.equal(s('(2)(M)(FT)Ewen T').status, 'new');
    assert.equal(s('(2)(M)(FT)Ewen T').hoursType, 'FT');
    assert.equal(s('(3)(F)Ann').assignable, false);
    assert.equal(s('(X)(1)(M)Bob').status, 'off_schedule');
    assert.equal(s('ON HOLD(1)(F)Jisele B').status, 'on_hold');
    assert.equal(s('ON HOLD (2)(F)Nicole T').name, 'Nicole T');
    assert.equal(s('Fabrice Name').status, 'no_code');
    assert.equal(s('Fabrice Name').assignable, false);
    assert.equal(s('(1)(F)Jane').gender, 'F');
  });
  test('tags become rules', () => {
    const c = parseCleaner({ id: 1, title: '(1)(M)Karlo', tags_info: ['Maximum of 45 mins travel time to a booking', 'Do not pair with Jean', 'Can take last minute bookings', 'No 2-HOUR Booking', "Do not assign new booking without cleaner's confirmation via call or text", 'Public transit', 'Move in/out cleaner'].map((name) => ({ name })) });
    assert.equal(c.rules.maxTravelMin, 45);
    assert.deepEqual(c.rules.doNotPair, ['jean']);
    assert.ok(c.rules.lastMinute && c.rules.noShort && c.rules.confirmFirst && c.rules.transit && c.rules.moveOut);
  });
  test('customer tags: preferences and do-not-assign', () => {
    const p = customerPrefs([{ name: 'Prefers female cleaner' }, { name: 'DO NOT assign Amy' }, { name: 'Prefers Loveline' }, { name: 'prefers consistent cleaner' }]);
    assert.ok(p.prefersFemale && p.consistent && !p.femaleOnly);
    assert.deepEqual(p.avoid, ['amy']);
    assert.deepEqual(p.prefers, ['loveline']);
    assert.ok(customerPrefs([{ name: '#female cleaner only' }]).femaleOnly);
  });
});

describe('schedule: the 4-week cycle', () => {
  test('weeks A-D from the anchor Monday', () => {
    assert.equal(cycleWeek('2026-11-02'), 'A');
    assert.equal(cycleWeek('2026-11-08'), 'A');
    assert.equal(cycleWeek('2026-11-10'), 'B');
    assert.equal(cycleWeek('2026-11-30'), 'A');
    assert.equal(cycleWeek('2026-10-27'), 'D');
  });
  test('frequencies map onto it', () => {
    assert.equal(frequencyKind('Prepaid Biweekly'), 'bi');
    assert.equal(frequencyKind('Biweekly 15% Off - Limited Time Only'), 'bi');
    assert.equal(frequencyKind('Tri-Weekly'), 'tri');
    assert.equal(frequencyKind('Weekly - 15% off'), 'weekly');
    assert.equal(frequencyKind('Monthly*'), 'monthly');
    assert.equal(frequencyKind('One Time'), 'one');
    assert.equal(cycleWeeks('bi', '2026-11-10'), 'BD');
    assert.equal(cycleWeeks('weekly', '2026-11-10'), 'ABCD');
    assert.equal(cycleWeeks('monthly', '2026-11-17'), 'C');
    assert.deepEqual(seriesDates('bi', '2026-11-10', '2026-12-10'), ['2026-11-10', '2026-11-24', '2026-12-08']);
  });
});

describe('schedule: fitting and ranking', () => {
  const rows = [1, 2, 3, 4, 5].map((d) => ({ weekday: d, date: null, dayoff: false, start_time: '09:00', end_time: '17:00' }));
  test('working window, day off, marked unavailable', () => {
    assert.deepEqual(workingWindow(rows, '2026-11-03'), [540, 1020]);
    assert.equal(workingWindow(rows, '2026-11-07'), null);
    assert.equal(workingWindow(rows, '2026-11-03', new Set(['2026-11-03'])), null);
    assert.deepEqual(workingWindow([...rows, { date: '2026-11-03', weekday: 2, dayoff: false, start_time: '12:00', end_time: '14:00' }], '2026-11-03'), [720, 840]);
  });
  test('travel time between visits counts', () => {
    const busy = [{ start: 540, end: 720, lat: 45.40, lng: -75.70, key: 'a' }];
    const near = { lat: 45.401, lng: -75.701 };
    const far = { lat: 45.30, lng: -75.95 };
    assert.equal(fitsDay({ window: [540, 1020], busy, start: 730, duration: 120, place: near }).ok, true);
    assert.equal(fitsDay({ window: [540, 1020], busy, start: 730, duration: 120, place: far }).reason, 'not enough time to get there');
    assert.equal(fitsDay({ window: [540, 1020], busy, start: 600, duration: 60, place: near }).reason, 'already booked');
    assert.equal(fitsDay({ window: [540, 1020], busy, start: 960, duration: 120, place: near }).reason, 'outside hours');
    assert.deepEqual(openGaps([540, 1020], busy, 120), [[720, 1020]]);
  });
  test('usual cleaner first; do-not-assign, female-only and status respected; recurring must fit', () => {
    const mk = (id, title, extra = {}) => ({ ...parseCleaner({ id, title, latitude: 45.40, longitude: -75.70 }), availability: rows, ...extra });
    const cleaners = [mk(1, '(1)(M)Amy Lee'), mk(2, '(1)(F)Bea Ray'), mk(3, '(1)(F)Cleo Dee'), mk(4, '(3)(F)Not Ready'), mk(5, 'ON HOLD(1)(F)Held')];
    const busy = new Map([['3|2026-11-17', [{ start: 540, end: 720, lat: 45.4, lng: -75.7, key: 'x' }]]]);
    const ctx = { today: '2026-11-02', windowFor: (c, d) => workingWindow(c.availability, d), busyFor: (id, d) => busy.get(`${id}|${d}`) || [], weekLoad: () => ({ booked: 10, capacity: 40 }) };
    const job = { dates: ['2026-11-03', '2026-11-17'], start: 600, duration: 180, place: { lat: 45.401, lng: -75.701 }, kind: 'bi', prefs: customerPrefs([{ name: 'DO NOT assign Amy' }]), mainCleanerId: 3, history: new Map([[3, 4], [2, 1]]) };
    const ranked = rankCleaners(job, cleaners, ctx);
    assert.deepEqual(ranked.map((r) => r.cleaner_id), [3, 2]);
    assert.equal(ranked[0].fits, 1, 'usual cleaner is busy on one date');
    assert.ok(ranked[0].reasons.some((r) => r.text === 'Usual cleaner'));
    const female = rankCleaners({ ...job, prefs: customerPrefs([{ name: 'female cleaner only' }]), mainCleanerId: null }, cleaners, ctx);
    assert.ok(female.every((r) => r.cleaner_id !== 1));
  });
  test('main cleaner = most of the last 6 visits', () => {
    const v = (date, id) => ({ date, team_ids: [id] });
    assert.deepEqual(mainCleaner([v('2026-01-01', 9), v('2026-09-01', 1), v('2026-09-15', 2), v('2026-09-29', 1), v('2026-10-13', 1)]), { id: 1, visits: 3, of: 5 });
  });
});

// ---------- service against a stand-in Launch27 ----------
const NOW = Date.parse('2026-11-02T14:00:00Z'); // Mon Nov 2, 9 am Toronto
function at(date, hour) {
  return `${date}T${String(hour + 5).padStart(2, '0')}:00:00Z`;
}
let id = 1000;
const B = (cust, date, hour, freq, team, extra = {}) => ({ id: id++, service_date: at(date, hour), duration: 180, frequency: { name: freq }, address: { latitude: 45.40, longitude: -75.70, city: 'Ottawa' }, user: { id: cust, name: `Client ${cust}`, tags_info: [] }, services: [{ name: 'Standard clean' }], teams: team ? [{ id: team, hours: 3 }] : [], ...extra });
function world() {
  id = 1000;
  const teams = [
    { id: 1, title: '(1)(F)Ann Usual', latitude: 45.40, longitude: -75.70, share: 22, tags_info: [{ name: 'Vehicle' }] },
    { id: 2, title: '(1)(F)Bea Backup', latitude: 45.41, longitude: -75.69, share: 22, tags_info: [] },
    { id: 3, title: 'ON HOLD(1)(F)Cat Held', latitude: 45.40, longitude: -75.70, share: 22, tags_info: [] },
  ];
  const avail = Object.fromEntries(teams.map((t) => [t.id, [1, 2, 3, 4, 5].map((d) => ({ weekday: d, date: null, dayoff: false, start_time: '08:00', end_time: '17:00' }))]));
  const bookings = [
    // Client 1: biweekly with Ann for months; upcoming visits have no cleaner.
    B(1, '2026-09-08', 9, 'Biweekly - 10% off', 1), B(1, '2026-09-22', 9, 'Biweekly - 10% off', 1), B(1, '2026-10-06', 9, 'Biweekly - 10% off', 1), B(1, '2026-10-20', 9, 'Biweekly - 10% off', 1),
    B(1, '2026-11-03', 9, 'Biweekly - 10% off', null), B(1, '2026-11-17', 9, 'Biweekly - 10% off', null),
    // Client 2: weekly with the held cleaner.
    B(2, '2026-10-26', 13, 'Weekly - 15% off', 3), B(2, '2026-11-04', 13, 'Weekly - 15% off', 3),
    // Client 3: one-time with Bea.
    B(3, '2026-11-05', 9, 'One time', 2),
  ];
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/latest/login') return json({ bearer: 'b' });
    if (u.pathname === '/v1/staff/teams') return json(Number(u.searchParams.get('offset')) ? [] : teams);
    const m = u.pathname.match(/^\/v1\/staff\/teams\/(\d+)\/availability$/);
    if (m) return json(avail[m[1]]);
    if (u.pathname === '/v1/staff/bookings/assign/teams' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      for (const bid of body.booking_ids) {
        const b = bookings.find((x) => x.id === bid);
        b.teams = body.teams.map((t) => ({ id: t.id, hours: t.hours }));
      }
      return json({});
    }
    const one = u.pathname.match(/^\/v1\/staff\/bookings\/(\d+)$/);
    if (one) {
      const b = bookings.find((x) => x.id === Number(one[1]));
      return b ? json(b) : json({ error: 'not found' }, 404);
    }
    if (u.pathname === '/v1/staff/bookings') {
      const from = u.searchParams.get('from');
      const to = u.searchParams.get('to');
      const list = bookings.filter((b) => b.service_date.slice(0, 10) >= from && b.service_date.slice(0, 10) <= to);
      const off = Number(u.searchParams.get('offset') || 0);
      return json(list.slice(off, off + 100));
    }
    return json({ error: 'nf' }, 404);
  };
  return { teams, avail, bookings, posts, fetchImpl };
}

describe('schedule: sync, plan, assign, changes', () => {
  test('end to end on a small schedule', async () => {
    const w = world();
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    let clock = NOW;
    const writes = createWriteLog({ db });
    const s = createSchedule({ db, config, fetchImpl: w.fetchImpl, log: quiet, now: () => clock, writes });
    await s.sync();

    const ov = await s.overview();
    assert.equal(ov.counts.assignable, 2);
    assert.equal(ov.counts.by_status.on_hold, 1);
    assert.equal(ov.counts.unassigned_visits, 2);
    assert.equal(ov.weeks[0].cycle, 'A');

    // Unassigned series: client 1's two biweekly visits, usual cleaner Ann first.
    const un = await s.unassigned();
    assert.equal(un.total_series, 1);
    assert.equal(un.series[0].visits.length, 2);
    assert.match(un.series[0].when, /weeks B\/D|weeks A\/C/);
    assert.equal(un.series[0].candidates[0].name, 'Ann Usual');
    assert.ok(un.series[0].candidates.every((c) => c.name !== 'Cat Held'));

    // Changes: unassigned + held cleaner's client.
    const ch = await s.changes();
    const kinds = ch.items.map((i) => i.kind).sort();
    assert.ok(kinds.includes('unassigned'));
    assert.ok(kinds.includes('cleaner_unavailable'));
    const un2 = ch.items.filter((i) => i.kind === 'unassigned');
    assert.equal(un2.length, 1, 'one card per series, not per visit');
    assert.equal(un2[0].series.count, 2);
    assert.equal(un2[0].suggestions[0].name, 'Ann Usual');
    const held = ch.items.find((i) => i.kind === 'cleaner_unavailable');
    assert.ok(held.suggestions.length > 0 && held.suggestions.every((x) => x.name !== 'Cat Held'));

    // Plan for Ann: 4 weeks, gaps where she is free.
    const plan = await s.plan(1);
    assert.equal(plan.weeks.length, 4);
    assert.ok(plan.weeks[0].cells.some((c) => c.gaps.length));

    // Find a slot: biweekly 3h for client 1 -> Ann, free every date.
    const slots = await s.findSlots({ customer_id: 1, duration: 180, kind: 'bi' });
    assert.ok(slots.slots.length > 0);
    assert.equal(slots.slots[0].cleaner.name, 'Ann Usual');
    assert.ok(slots.slots.every((x) => x.cleaner.name !== 'Cat Held'));

    // Rescheduling: the client asked for the same cleaner -> only Ann's openings.
    const same = await s.findSlots({ customer_id: 1, duration: 180, kind: 'bi', cleaner: 'same' });
    assert.equal(same.cleaner, 'same');
    assert.ok(same.slots.length > 0 && same.slots.every((x) => x.cleaner.name === 'Ann Usual'));
    // Same cleaner but nothing fits (8h a week) -> no slots, and a count of what others could do.
    const tight = await s.findSlots({ customer_id: 1, duration: 600, kind: 'weekly', cleaner: 'same' });
    assert.equal(tight.slots.length, 0);
    assert.equal(typeof tight.any_count, 'number');
    // No usual cleaner on file -> falls back to any cleaner and says so.
    const fresh = await s.findSlots({ duration: 180, kind: 'one', cleaner: 'same' });
    assert.equal(fresh.no_usual, true);
    assert.equal(fresh.cleaner, 'any');
    // Moving an existing booking: its own time no longer blocks the search.
    const own = w.bookings.find((b) => b.team_ids?.includes?.(1) || (b.teams || []).some((t) => t.id === 1));
    assert.ok(own, "Ann has a booking to move");
    {
      const without = await s.findSlots({ customer_id: 1, duration: 180, kind: 'one', cleaner: 'same' });
      const moving = await s.findSlots({ customer_id: 1, duration: 180, kind: 'one', cleaner: 'same', booking_id: own.id });
      assert.ok(moving.slots.length >= without.slots.length);
    }

    // Assign the series to Ann: one Launch27 call per real booking, change resolved.
    const res = await s.assign({ visit_keys: un.series[0].visits.map((v) => v.key), cleaner_id: 1 }, 'user-bearer', 'planner@example.com');
    assert.equal(res.assigned, 2);
    assert.deepEqual(w.posts[0], { booking_ids: [w.bookings[4].id], teams: [{ id: 1, hours: 3, share: 22 }] });
    // The planner's assignment is in the write log, with who did it and what was sent.
    const logged = (await writes.list()).rows.filter((r) => r.source === 'planner assign' && r.outcome === 'done');
    assert.equal(logged.length, w.posts.length);
    assert.equal(logged.at(-1).user_email, 'planner@example.com');
    assert.equal(logged.at(-1).booking_id, w.bookings[4].id);
    assert.ok((await s.changes()).items.every((i) => i.kind !== 'unassigned'));
    await assert.rejects(() => s.assign({ visit_keys: ['x'], cleaner_id: 3 }, 'b'), /on hold/);

    // Marking Ann unavailable on Nov 3 flags her visit there.
    await s.markUnavailable(1, '2026-11-03', {});
    assert.ok((await s.changes()).items.some((i) => i.kind === 'cleaner_unavailable' && i.title.includes('Ann Usual')));
    await s.markUnavailable(1, '2026-11-03', { on: false });

    // A customer moves a visit, another is cancelled, and Bea's hours change: next sync sees all three.
    w.bookings[4].service_date = at('2026-11-04', 11);
    const cancelled = w.bookings.splice(8, 1)[0];
    w.avail[2] = w.avail[2].map((r) => ({ ...r, end_time: '12:00' }));
    clock += 20 * 60_000;
    await s.sync();
    const after = (await s.changes()).items;
    assert.ok(after.some((i) => i.kind === 'moved' && /moved from Tue, Nov 3 9am to Wed, Nov 4 11am/.test(i.title)));
    assert.ok(after.some((i) => i.kind === 'cancelled' && i.title.includes(cancelled.user.name)));
    assert.ok(after.some((i) => i.kind === 'availability' && i.title.includes("Bea Backup's hours changed")));

    // Dismissing removes it from the list.
    const one = after.find((i) => i.kind === 'cancelled');
    await s.resolveChange(one.id, 'dismissed', null);
    assert.ok((await s.changes()).items.every((i) => i.id !== one.id));
  });

  test('regenerated sample data starts the planner fresh instead of flagging every visit as moved', async () => {
    const w = world();
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const s = createSchedule({ db, config, fetchImpl: w.fetchImpl, log: quiet, now: () => NOW });
    await s.sync();
    // Pretend the stored snapshot came from an older generator, then the sample visits all change.
    await db.query("UPDATE schedule_snapshots SET data = data - 'sample'");
    await db.query("INSERT INTO schedule_changes (key, kind, title) VALUES ('old:1', 'moved', 'Old noise')");
    for (const b of w.bookings) b.service_date = b.service_date.replace(/T(\d\d)/, (m, h) => `T${String((Number(h) + 1) % 24).padStart(2, '0')}`);
    const s2 = createSchedule({ db, config, fetchImpl: w.fetchImpl, log: quiet, now: () => NOW });
    await s2.sync();
    const items = (await s2.changes()).items;
    assert.ok(!items.some((i) => ['moved', 'cancelled', 'cleaner_changed'].includes(i.kind)), 'no diff noise');
    assert.ok(!items.some((i) => i.title === 'Old noise'), 'old open items are cleared');
  });

  test('a QA copy arriving is noticed, and reset clears the planner for a clean rebuild', async () => {
    const w = world();
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    let tag = 2;
    const s = createSchedule({ db, config, fetchImpl: w.fetchImpl, log: quiet, now: () => NOW, dataTag: () => tag });
    await s.sync();
    assert.equal(await s.dataChanged(), false);
    tag = 'qa:2026-11-03T01:57:09Z';
    assert.equal(await s.dataChanged(), true, 'sample-stamped snapshot vs a QA copy');
    await s.reset();
    assert.equal((await db.query('SELECT count(*)::int AS n FROM schedule_snapshots')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM schedule_changes WHERE resolved_at IS NULL')).rows[0].n, 0);
    await s.sync();
    assert.equal(await s.dataChanged(), false, 'stamped with the copy after the rebuild');
    const live = createSchedule({ db, config: loadConfig({ APP_ENV: 'production', NODE_ENV: 'production', L27_MODE: 'live' }), fetchImpl: w.fetchImpl, log: quiet });
    await assert.rejects(() => live.reset(), /only for sample/);
  });

  test('without a sync login (production today), it refreshes with the viewer\'s own login while the planner is open', async () => {
    const w = world();
    const db = await openDb();
    const config = { ...loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' }), l27Mode: 'live', l27SyncEmail: null, l27SyncPassword: null };
    const seen = [];
    const fetchImpl = (url, init = {}) => {
      seen.push(init.headers?.authorization || '');
      return w.fetchImpl(url, init);
    };
    let clock = NOW;
    const s = createSchedule({ db, config, fetchImpl, log: quiet, now: () => clock });
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 30));
      while (s.isRunning()) await new Promise((r) => setTimeout(r, 20));
    };
    await s.maybeRun();
    await settle();
    assert.equal((await s.status()).taken_at, null, 'no login, nobody watching: nothing runs');
    await s.maybeRun({ bearer: 'viewer-token' });
    await settle();
    const first = await s.status();
    assert.ok(first.taken_at, 'a viewer starts the first full load');
    assert.ok(seen.length && seen.every((h) => h === 'Bearer viewer-token'), "uses the viewer's login");
    await s.maybeRun({ bearer: 'viewer-token' });
    await settle();
    assert.equal((await s.status()).taken_at, first.taken_at, 'not again within 3 minutes');
    clock += 4 * 60_000;
    await s.maybeRun({ bearer: 'viewer-token' });
    await settle();
    assert.notEqual((await s.status()).taken_at, first.taken_at, 'quick refresh after 3 minutes');
  });

  test('quick refresh: next 14 days every few minutes; moved further out reads as moved, not cancelled', async () => {
    const w = world();
    const db = await openDb();
    let clock = NOW;
    const s = createSchedule({ db, config: loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' }), fetchImpl: w.fetchImpl, log: quiet, now: () => clock });
    await s.maybeRun();
    await new Promise((r) => setTimeout(r, 50));
    while (s.isRunning()) await new Promise((r) => setTimeout(r, 20));
    const first = await s.status();
    assert.ok(first.taken_at && first.full_at === first.taken_at, 'first refresh is a full one');

    // Client 3's one-time moves from Nov 5 to Nov 25 (beyond 14 days); client 2's Nov 4 visit is cancelled.
    const moved = w.bookings.find((b) => b.user.id === 3);
    moved.service_date = at('2026-11-25', 10);
    const cancelledAt = w.bookings.findIndex((b) => b.user.id === 2 && b.service_date.startsWith('2026-11-04'));
    w.bookings.splice(cancelledAt, 1);

    clock += 4 * 60_000; // past the quick-refresh interval, well before the hourly full one
    await s.maybeRun();
    await new Promise((r) => setTimeout(r, 50));
    while (s.isRunning()) await new Promise((r) => setTimeout(r, 20));
    const st = await s.status();
    assert.notEqual(st.taken_at, first.taken_at);
    assert.equal(st.full_at, first.full_at, 'a quick refresh, not a full one');
    const items = (await s.changes()).items;
    assert.ok(items.some((i) => i.kind === 'moved' && /Client 3 moved from Thu, Nov 5 9am to Wed, Nov 25 10am/.test(i.title)));
    assert.ok(items.some((i) => i.kind === 'cancelled' && i.title.includes('Client 2')));
    assert.ok(!items.some((i) => i.kind === 'cancelled' && i.title.includes('Client 3')));
    // The moved visit is in the schedule at its new date.
    const plan = await s.plan(2);
    assert.ok(plan.weeks.some((wk) => wk.cells.some((c) => c.date === '2026-11-25' && c.visits.some((v) => v.customer === 'Client 3'))));

    // An hour on, the next refresh is a full one.
    clock += 61 * 60_000;
    await s.maybeRun();
    await new Promise((r) => setTimeout(r, 50));
    while (s.isRunning()) await new Promise((r) => setTimeout(r, 20));
    assert.notEqual((await s.status()).full_at, first.full_at);
  });

  test('production refreshes only with its own read-only login', async () => {
    const db = await openDb();
    const warnings = [];
    const s = createSchedule({ db, config: loadConfig({ APP_ENV: 'production', NODE_ENV: 'production', L27_MODE: 'live' }), fetchImpl: async () => { throw new Error('no calls'); }, log: { ...quiet, warn: (m) => warnings.push(m) }, now: () => NOW });
    await s.maybeRun();
    assert.match(warnings[0], /L27_SYNC_EMAIL/);
    await assert.rejects(() => s.overview(), /not been loaded yet/);
  });
});

describe('QA copy: cleaner hours come from their visits', () => {
  test('working days and hours inferred in Toronto time; no visits means a weekday 9 to 5', async () => {
    const { copyAvailability } = await import('../src/mock/launch27.js');
    const { createMockLaunch27 } = await import('../src/mock/launch27.js');
    const visit = (id, date, hourUtc, dur, team) => ({ id, active: true, service_date: `${date}T${String(hourUtc).padStart(2, '0')}:00:00Z`, duration: dur, teams: [{ id: team }] });
    const bookings = [
      visit(1, '2026-11-02', 13, 180, 77), visit(2, '2026-11-09', 18, 120, 77), // Mondays 8am and 1pm Toronto
      visit(3, '2026-11-04', 14, 240, 77), visit(4, '2026-11-11', 14, 240, 77), // Wednesdays 9am
      visit(5, '2026-11-06', 14, 180, 77), visit(6, '2026-11-07', 14, 180, 77), // a Friday and a Saturday, once each
    ];
    const f = createMockLaunch27({ snapshot: () => ({ teams: [{ id: 77, title: '(1) A B' }, { id: 78, title: '(1) C D' }], customers: [], bookings, services: {}, locations: [] }) });
    const get = async (id) => (await f(`https://x.launch27.com/v1/staff/teams/${id}/availability`, { headers: { authorization: 'Bearer mock-bearer' } })).json();
    const a = await get(77);
    assert.deepEqual(a.filter((d) => !d.dayoff).map((d) => [d.weekday, d.start_time, d.end_time]), [[1, '08:00', '15:00'], [3, '09:00', '13:00']]);
    const b = await get(78);
    assert.deepEqual(b.filter((d) => !d.dayoff).map((d) => d.weekday), [1, 2, 3, 4, 5]);
    assert.equal(typeof copyAvailability, 'function');
  });
});
