import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrefText, splitNames, matchCleaner, matchClient, continuitySuggestion, fsaOf, clusterOf, tierFromTitle } from '../src/crew/prefs.js';
import { createCrew, isResidentialOttawa } from '../src/crew/service.js';
import { openDb } from '../src/db/index.js';
import { loadConfig, canUseCrewPlanner } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createSchedule } from '../src/schedule/service.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';

const quiet = { info() {}, warn() {}, error() {} };
const types = (s) => parsePrefText(s).map((p) => [p.type, ...p.names]);

describe('crew planner: reading preferences from Launch27 text', () => {
  test('the real note strings', () => {
    assert.deepEqual(types('prefers Karen'), [['PREF_CLEANER', 'Karen']]);
    assert.deepEqual(types('Ruth only'), [['PREF_CLEANER', 'Ruth']]);
    assert.deepEqual(types('Etelvina or Khadra only'), [['PREF_CLEANER', 'Etelvina', 'Khadra']]);
    assert.deepEqual(types('same cleaner please'), [['CONSISTENT_CLEANER']]);
    assert.deepEqual(types('Consistent cleaner'), [['CONSISTENT_CLEANER']]);
    assert.deepEqual(types('Female cleaner requested'), [['FEMALE_ONLY']]);
    assert.deepEqual(types('female only'), [['FEMALE_ONLY']]);
    assert.deepEqual(types('Consistent female cleaner'), [['FEMALE_ONLY'], ['CONSISTENT_CLEANER']]);
    assert.deepEqual(types('do not assign Faridah'), [['AVOID_CLEANER', 'Faridah']]);
    assert.deepEqual(types('Do not send Andrew'), [['AVOID_CLEANER', 'Andrew']]);
    assert.deepEqual(types('Requested not to be booked with Thi Thu'), [['AVOID_CLEANER', 'Thi Thu']]);
    assert.deepEqual(types('requested not to be booked'), [['PENDING_CANCEL']]);
    assert.deepEqual(types('Appointment should be at 9AM, do not move'), [['FIXED_TIME']]);
    assert.deepEqual(types('No trainees'), [['NO_TRAINEES']]);
    assert.deepEqual(types('Owes $120 from last visit'), [['HOLD_UNPAID']]);
    assert.deepEqual(types('Wants to cancel after December'), [['PENDING_CANCEL']]);
  });

  test('a fallback cleaner keeps the order: first choice first', () => {
    assert.deepEqual(types('Tyler if Karlo is unavailable'), [['PREF_CLEANER', 'Karlo', 'Tyler']]);
  });

  test('dates, "client" and extra words are ignored; one field can hold several lines', () => {
    assert.deepEqual(types('11/02/2026: Client prefers Sadam for deep cleans'), [['PREF_CLEANER', 'Sadam']]);
    assert.deepEqual(types('TJ only; no trainees'), [['PREF_CLEANER', 'TJ'], ['NO_TRAINEES']]);
    assert.deepEqual(types('Jane Doe\n613-555-0101\nPlease use the side door.'), []);
    assert.deepEqual(splitNames('Karen & Mo'), ['Karen', 'Mo']);
  });
});

describe('crew planner: matching names', () => {
  const cleaners = [
    { id: 1, name: 'Olatunji Olakitan', aliases: ['TJ'] },
    { id: 2, name: 'Thi Thu Thao Le' },
    { id: 3, name: 'Ruth Nelie Misse Oyono' },
    { id: 4, name: 'Amy Cockerton' },
    { id: 5, name: 'Amy Lee' },
    { id: 6, name: 'Mohamed Sadam' },
  ];
  test('full name, alias, start of the name, a unique word', () => {
    assert.deepEqual(matchCleaner('TJ', cleaners), { id: 1 });
    assert.deepEqual(matchCleaner('thi thu', cleaners), { id: 2 });
    assert.deepEqual(matchCleaner('Ruth', cleaners), { id: 3 });
    assert.deepEqual(matchCleaner('Sadam', cleaners), { id: 6 });
    assert.deepEqual(matchCleaner('Amy Cockerton', cleaners), { id: 4 });
  });
  test('two cleaners with the same first name: ambiguous, never a guess', () => {
    assert.deepEqual(matchCleaner('Amy', cleaners), { ambiguous: [4, 5] });
    assert.equal(matchCleaner('Floyd', cleaners), null);
  });
  test('clients: first and last name, middle initials ignored', () => {
    const customers = [{ id: 10, name: 'Denis Gervais' }, { id: 11, name: 'Liz Mitchell' }, { id: 12, name: 'Liz Mitchell' }];
    assert.deepEqual(matchClient('Denis R Gervais', customers), { id: 10 });
    assert.deepEqual(matchClient('Liz Mitchell', customers), { ambiguous: [11, 12] });
    assert.equal(matchClient('Gervais', customers), null);
  });
  test('history suggests a regular: 3+ visits and more than half', () => {
    assert.deepEqual(continuitySuggestion({ 7: 4, 8: 2 }), { cleaner_id: 7, visits: 4, of: 6 });
    assert.equal(continuitySuggestion({ 7: 3, 8: 3 }), null);
    assert.equal(continuitySuggestion({ 7: 2 }), null);
  });
  test('title codes give the tier', () => {
    assert.equal(tierFromTitle('(1)(F)(FT) Jane Doe'), 1);
    assert.equal(tierFromTitle('ON HOLD(2)(M) Joe'), 2);
    assert.equal(tierFromTitle('Joe'), null);
  });
});

describe('crew planner: postal-code areas', () => {
  const areas = new Map([['K2G', 'West inner / Nepean'], ['K1P', 'Central']]);
  test('FSA is the first three characters, any spacing or case', () => {
    assert.equal(fsaOf('k2g 2x1'), 'K2G');
    assert.equal(fsaOf('K2G2X1'), 'K2G');
    assert.equal(fsaOf('12345'), null);
    assert.equal(clusterOf('K2G 2X1', areas), 'West inner / Nepean');
    assert.equal(clusterOf('k1p1a1', areas), 'Central');
    assert.equal(clusterOf('K9Z 1A1', areas), null);
  });
  test('the seeded areas cover Ottawa', async () => {
    const db = await openDb();
    const crew = createCrew({ db, config: loadConfig({ APP_ENV: 'development' }), schedule: {} });
    assert.equal(await crew.areaOf('K2G 2X1'), 'West inner / Nepean'); // the depot, 34 Westwood
    assert.equal(await crew.areaOf('K2J 0A1'), 'Barrhaven');
    assert.equal(await crew.areaOf('K4A 1A1'), 'East outer / Orleans');
    await db.close();
  });
});

describe('crew planner: only Residential Ottawa', () => {
  test('Commercial, Cornwall, partners and other cities are out', () => {
    const v = (location_name, over = {}) => ({ location_id: 1, location_name, ...over });
    assert.equal(isResidentialOttawa(v('Ottawa')), true);
    assert.equal(isResidentialOttawa(v('Commercial Ottawa')), false);
    assert.equal(isResidentialOttawa(v('Cornwall')), false);
    assert.equal(isResidentialOttawa(v('Kitchener-Waterloo')), false);
    assert.equal(isResidentialOttawa(v('Ottawa', { partner: 'carefor', partner_kind: 'homemaking' })), false);
    assert.equal(isResidentialOttawa(v(null)), false);
    // An admin moved the Ottawa location to the commercial brand.
    assert.equal(isResidentialOttawa(v('Ottawa'), new Map([[1, 'commercial']])), false);
  });
});

describe('crew planner: who can use it', () => {
  test('admins and CREW_PLANNER_EMAILS; off in production unless switched on', () => {
    const dev = loadConfig({ APP_ENV: 'development', CREW_PLANNER_EMAILS: 'Grace@UrbanMop.ca', ADMIN_EMAILS: 'boss@example.com' });
    assert.equal(canUseCrewPlanner(dev, 'grace@urbanmop.ca'), true);
    assert.equal(canUseCrewPlanner(dev, 'boss@example.com'), true);
    assert.equal(canUseCrewPlanner(dev, 'agent@example.com'), false);
    assert.equal(canUseCrewPlanner(dev, 'agent@example.com', 'admin'), true);
    assert.equal(canUseCrewPlanner(dev, 'agent@example.com', 'supervisor'), false);
    const prod = { APP_ENV: 'production', DATABASE_URL: 'x', SESSION_SECRET: 'x'.repeat(40), CREW_PLANNER_EMAILS: 'grace@urbanmop.ca' };
    assert.equal(canUseCrewPlanner(loadConfig(prod), 'grace@urbanmop.ca'), false);
    assert.equal(canUseCrewPlanner(loadConfig({ ...prod, CREW_PLANNER_ENABLED: 'true' }), 'grace@urbanmop.ca'), true);
  });
});

// A small Launch27 world, as the Scheduling planner's saved copy would give it.
function world() {
  const cl = (id, title, over = {}) => ({ id, name: title.replace(/^(\s*\([^)]*\))*\s*/, ''), title, status: 'active', status_label: 'Active', gender: /\(F\)/.test(title) ? 'F' : /\(M\)/.test(title) ? 'M' : null, location_ids: [1], ...over });
  const cleaners = [
    cl(1, '(1)(M)(FT) Olatunji Olakitan'),
    cl(2, '(1)(F) Thi Thu Thao Le'),
    cl(3, '(1)(F) Ruth Nelie Misse Oyono'),
    cl(4, '(1)(F) Amy Cockerton'),
    cl(5, '(2)(F) Etelvina Cardoso'),
    cl(6, '(1)(F) Khadra Hassan'),
    cl(7, '(1)(M) Karlo Jeffrey Yu'),
    cl(8, '(1)(M) Tyler Brown'),
    cl(9, '(1)(M) Dominic Dumulon'),
    cl(10, '(1)(F) Hodan Ali Elmi'),
    cl(11, '(1)(F) Casey Wilson'), // not Caysi Thorne, whatever her nickname
  ];
  const v = (key, customer_id, customer, date, team, over = {}) => ({ key, customer_id, customer, date, start: 540, duration: 180, team_ids: team, location_id: 1, location_name: 'Ottawa', zip: 'K2G 2X1', ctags: [], staff_notes: null, customer_notes: null, kind: 'weekly', ...over });
  const visits = [
    v('a1', 100, 'Louise Legault', '2026-11-17', [1], { ctags: ['Prefers TJ'] }),
    v('b1', 101, 'Tripti Mukherjee', '2026-11-18', [5]),
    v('c1', 102, 'Laurie Federgreen', '2026-11-18', [8]),
    v('d1', 103, 'Pamela Walker', '2026-11-19', [4], { staff_notes: 'Pamela Walker\nRequested not to be booked with Thi Thu' }),
    v('e1', 104, 'Dorothy Greenberg', '2026-11-19', [3]),
    v('f1', 105, 'Wade Cuthbertson', '2026-11-20', [10], { staff_notes: 'Owes $95 from Nov 6 visit' }),
    v('g1', 106, 'Big Office', '2026-11-20', [4], { location_id: 167, location_name: 'Commercial Ottawa', staff_notes: 'prefers Amy' }),
    v('h1', 107, 'Regular Client', '2026-11-20', [4]),
    v('i1', 108, 'Dom Client', '2026-11-20', [9]),
    v('j1', 109, 'Note Client', '2026-11-20', [4], { staff_notes: 'Note Client\n10/02/2026: prefers Khadra' }),
  ];
  const customers = [
    { id: 100, name: 'Louise Legault', recurring: true, history: { 1: 2 } },
    { id: 101, name: 'Tripti Mukherjee', recurring: true, history: {} },
    { id: 102, name: 'Laurie Federgreen', recurring: true, history: {} },
    { id: 103, name: 'Pamela Walker', recurring: true, history: {} },
    { id: 104, name: 'Dorothy Greenberg', recurring: true, history: {} },
    { id: 105, name: 'Wade Cuthbertson', recurring: true, history: {} },
    { id: 106, name: 'Big Office', recurring: true, history: { 4: 6 } },
    { id: 107, name: 'Regular Client', recurring: true, history: { 4: 5, 2: 1 } },
    { id: 108, name: 'Dom Client', recurring: true, history: { 9: 6 } },
    { id: 109, name: 'Note Client', recurring: true, history: {} },
  ];
  return { taken_at: '2026-11-12T12:00:00Z', today: '2026-11-12', cleaners, visits, customers };
}

async function setup(seedOverride = null) {
  const db = await openDb();
  const grace = (await db.query("INSERT INTO users (email, name, role) VALUES ('grace@urbanmop.ca', 'Grace', 'supervisor') RETURNING *")).rows[0];
  const admin = (await db.query("INSERT INTO users (email, name, role) VALUES ('derek@example.com', 'Derek', 'admin') RETURNING *")).rows[0];
  let w = world();
  const schedule = { crewSource: async () => w };
  const crew = createCrew({ db, config: loadConfig({ APP_ENV: 'development' }), schedule, log: quiet, ...(seedOverride ? { seedUrl: seedOverride } : {}) });
  return { db, crew, grace, admin, setWorld: (fn) => (w = fn(w)) };
}

describe('crew planner: the starting seed', () => {
  test('matches names to Launch27, confirms prefs, and sends the unclear ones to a person', async () => {
    const { db, crew, admin } = await setup();
    const report = await crew.loadSeed(admin);
    // Cleaners in this small world are set up; the rest are listed as not found.
    assert.ok(report.cleaners.set.some((x) => x.startsWith('Olatunji Olakitan')));
    assert.ok(report.cleaners.unmatched.includes('Lucie Moline'));
    assert.ok(report.needs_decision.some((d) => /Ruth/.test(d.what)));
    const prof = new Map((await db.query('SELECT * FROM cp_cleaner_profile')).rows.map((r) => [Number(r.cleaner_id), r]));
    assert.equal(prof.get(3).protected, true); // Ruth Nelie stays protected: the bare "Ruth (on hold)" isn't applied
    assert.equal(prof.get(3).status, 'active');
    assert.equal(prof.get(7).status, 'on_hold'); // Karlo, mat leave
    assert.equal(prof.get(9).status, 'inactive'); // Dom
    assert.equal(prof.get(10).low_performer, true); // Hodan
    // A nickname alone never matches: "Casey" is someone else here.
    assert.equal(prof.has(11), false);
    assert.ok(report.cleaners.unmatched.includes('Caysi Thorne'));
    assert.deepEqual(prof.get(1).prefers_job_types, ['prepaid', 'one_time', 'move_in_out']); // TJ

    const { prefs } = await crew.prefs();
    const get = (client, type) => prefs.filter((p) => p.client_name === client && p.type === type);
    assert.deepEqual(get('Louise Legault', 'PREF_CLEANER')[0].cleaners.map((c) => c.id), [1]);
    assert.equal(get('Louise Legault', 'NO_TRAINEES')[0].status, 'confirmed');
    assert.deepEqual(get('Tripti Mukherjee', 'PREF_CLEANER')[0].cleaners.map((c) => c.id), [5, 6]);
    assert.deepEqual(get('Laurie Federgreen', 'PREF_CLEANER')[0].cleaners.map((c) => c.id), [7, 8]); // Karlo first, then Tyler
    assert.deepEqual(get('Pamela Walker', 'AVOID_CLEANER')[0].cleaners.map((c) => c.id), [2]);
    assert.deepEqual(get('Dorothy Greenberg', 'PREF_CLEANER')[0].cleaners.map((c) => c.id), [3]);
    assert.ok(prefs.every((p) => p.status === 'confirmed' && p.source === 'grace_manual'));
    assert.ok(report.prefs.unmatched_clients.includes('Sem Ponnambalam'));

    // Loading again changes nothing, and never undoes an edit made in the app.
    await crew.saveCleaner(3, { status: 'on_hold' }, admin);
    const again = await crew.loadSeed(admin);
    assert.equal(again.prefs.added.length, 0);
    assert.equal((await db.query('SELECT status FROM cp_cleaner_profile WHERE cleaner_id = 3')).rows[0].status, 'on_hold');
    await db.close();
  });
});

describe('crew planner: preferences found in Launch27', () => {
  test('pending until confirmed; a rejected one is never suggested again', async () => {
    const { db, crew, grace, admin } = await setup();
    await crew.loadSeed(admin);
    const out = await crew.ingest();
    assert.ok(out.created > 0);
    const pending = (await crew.prefs({ status: 'pending' })).prefs;
    const by = (client) => pending.filter((p) => p.client_name === client);
    // Notes: a new "prefers Khadra"; Wade's balance. Pamela's "requested not to be booked with
    // Thi Thu" is already confirmed from the seed, so it isn't asked again.
    assert.deepEqual(by('Note Client').map((p) => [p.type, p.source, p.cleaners.map((c) => c.id)]), [['PREF_CLEANER', 'launch27_note', [6]]]);
    assert.equal(by('Pamela Walker').length, 0);
    assert.deepEqual(by('Wade Cuthbertson').map((p) => p.type), ['HOLD_UNPAID']);
    // History: Regular Client had Amy 5 of 6.
    assert.deepEqual(by('Regular Client').map((p) => [p.type, p.source, p.cleaners[0].id]), [['PREF_CLEANER', 'continuity_history', 4]]);
    // Dom left: his clients aren't told "prefers Dom".
    assert.equal(by('Dom Client').length, 0);
    // Louise's "Prefers TJ" tag is already confirmed from the seed: not asked again.
    assert.equal(by('Louise Legault').length, 0);
    // Commercial clients are never read.
    assert.equal(pending.some((p) => p.client_name === 'Big Office'), false);

    const wade = by('Wade Cuthbertson')[0];
    await crew.prefAction(wade.id, 'reject', grace);
    const regular = by('Regular Client')[0];
    await crew.prefAction(regular.id, 'confirm', grace);
    await crew.ingest({ force: true });
    const after = (await crew.prefs()).prefs;
    assert.equal(after.filter((p) => p.client_name === 'Wade Cuthbertson').length, 1);
    assert.equal(after.find((p) => p.client_name === 'Wade Cuthbertson').status, 'rejected');
    assert.equal(after.find((p) => p.id === regular.id).confirmed_by, 'Grace');
    const log = (await db.query("SELECT action FROM audit_log WHERE action LIKE 'crew.%' ORDER BY id")).rows.map((r) => r.action);
    assert.ok(log.includes('crew.seed.loaded') && log.includes('crew.pref.reject') && log.includes('crew.pref.confirm'));
    await db.close();
  });

  test('a cleaner preference needs a cleaner before it can be confirmed', async () => {
    const { db, crew, grace } = await setup();
    const { id } = await crew.addPref({ client_id: 100, client_name: 'Louise Legault', type: 'FIXED_TIME' }, grace);
    assert.ok(id);
    await assert.rejects(crew.addPref({ client_id: 100, type: 'PREF_CLEANER', cleaner_ids: [] }, grace), /Pick at least one cleaner/);
    await assert.rejects(crew.addPref({ client_id: 100, type: 'NOT_A_TYPE' }, grace), /type is one of/);
    await db.close();
  });
});

describe('crew planner: cleaner profiles', () => {
  test('Launch27 codes until someone changes them; ratings are for admins', async () => {
    const { db, crew, grace, admin } = await setup();
    let list = (await crew.cleaners()).cleaners;
    const etelvina = list.find((c) => c.id === 5);
    assert.equal(etelvina.tier, 2);
    assert.equal(etelvina.tier_from, 'launch27');
    assert.equal(etelvina.gender, 'F');
    assert.equal('rating_pct' in etelvina, false);
    await crew.saveCleaner(5, { tier: 3, low_performer: true }, grace);
    await assert.rejects(crew.saveCleaner(5, { rating_pct: 80 }, grace), /Only admins/);
    await crew.saveCleaner(5, { rating_pct: 80 }, admin);
    await assert.rejects(crew.saveCleaner(5, { crew_role: 'boss' }, grace), /crew role is one of/);
    list = (await crew.cleaners({ admin: true })).cleaners;
    const e2 = list.find((c) => c.id === 5);
    assert.equal(e2.tier, 3);
    assert.equal(e2.tier_from, 'app');
    assert.equal(e2.low_performer, true);
    assert.equal(e2.rating_pct, 80);
    assert.equal(e2.gender, 'F'); // untouched fields keep Launch27's value
    await db.close();
  });
});

describe('crew planner: over HTTP', () => {
  test('only admins and the planner see it; everyone else gets a 404', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo', CREW_PLANNER_EMAILS: 'grace@urbanmop.ca', ADMIN_EMAILS: 'boss@example.com' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    await schedule.sync();
    const crew = createCrew({ db, config, schedule, log: quiet });
    const server = createApp(config, { fetchImpl, db, schedule, crew }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = async (email) => {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo' }) });
      const cookie = res.headers.get('set-cookie').split(';')[0];
      await fetch(`${base}/api/me`, { headers: { cookie } }); // creates the user row
      return cookie;
    };
    try {
      const boss = await login('boss@example.com');
      const grace = await login('grace@urbanmop.ca');
      const agent = await login('agent@example.com');
      const me = async (cookie) => (await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json()).features.crewPlanner;
      assert.equal(await me(boss), true);
      assert.equal(await me(grace), true);
      assert.equal(await me(agent), false);
      assert.equal((await fetch(`${base}/api/crew/status`, { headers: { cookie: agent } })).status, 404);
      assert.equal((await fetch(`${base}/api/crew/cleaners`, { headers: { cookie: grace } })).status, 200);
      const cleaners = (await (await fetch(`${base}/api/crew/cleaners`, { headers: { cookie: grace } })).json()).cleaners;
      assert.ok(cleaners.length > 0 && cleaners.every((c) => !('rating_pct' in c)));
      const adminView = (await (await fetch(`${base}/api/crew/cleaners`, { headers: { cookie: boss } })).json()).cleaners;
      assert.ok(adminView.every((c) => 'rating_pct' in c));
      assert.equal((await fetch(`${base}/api/crew/seed`, { method: 'POST', headers: { cookie: grace } })).status, 403);
      assert.equal((await fetch(`${base}/api/crew/seed`, { method: 'POST', headers: { cookie: boss } })).status, 200);
      const scan = await fetch(`${base}/api/crew/prefs-scan`, { method: 'POST', headers: { cookie: grace } });
      assert.equal(scan.status, 200);
      const prefs = await (await fetch(`${base}/api/crew/prefs?status=pending`, { headers: { cookie: grace } })).json();
      assert.ok(prefs.prefs.length > 0, 'the sample data has preference tags to review');
      const areas = await (await fetch(`${base}/api/crew/areas`, { headers: { cookie: grace } })).json();
      assert.ok(areas.clusters.length >= 37);
      // Nothing here writes to Launch27.
      assert.equal((await db.query('SELECT count(*)::int AS n FROM l27_writes')).rows[0].n, 0);
    } finally {
      server.close();
      await db.close();
    }
  });

  test('switched off: a 404 for everyone, admins included', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo', CREW_PLANNER_ENABLED: 'false', ADMIN_EMAILS: 'boss@example.com' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const crew = createCrew({ db, config, schedule, log: quiet });
    const server = createApp(config, { fetchImpl, db, schedule, crew }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'boss@example.com', password: 'demo' }) });
      const cookie = res.headers.get('set-cookie').split(';')[0];
      assert.equal((await fetch(`${base}/api/crew/status`, { headers: { cookie } })).status, 404);
      assert.equal((await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json()).features.crewPlanner, false);
    } finally {
      server.close();
      await db.close();
    }
  });
});
