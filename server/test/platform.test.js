import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { configErrors, loadConfig, resolveAppEnv } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { loadMigrations, migrationStatus, runMigrations, splitStatements } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { SessionStore } from '../src/sessions.js';
import { createLogger, redact } from '../src/log.js';
import { guardConnectors, sendOutbound } from '../src/inbox/channels.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';

describe('environment guards', () => {
  test('resolves the app environment from APP_ENV, Railway, or NODE_ENV', () => {
    assert.equal(resolveAppEnv({ APP_ENV: 'qa' }), 'staging');
    assert.equal(resolveAppEnv({ RAILWAY_ENVIRONMENT_NAME: 'development' }), 'development');
    assert.equal(resolveAppEnv({ NODE_ENV: 'production' }), 'production');
    assert.equal(resolveAppEnv({}), 'development');
  });

  test('hosted dev/QA can never use live Launch27, live writes, or live notifications', () => {
    const c = loadConfig({ RAILWAY_ENVIRONMENT_NAME: 'staging', L27_MODE: 'live', L27_ALLOW_WRITES: 'true', NOTIFICATIONS_MODE: 'live', DATABASE_URL: 'postgres://x' });
    assert.equal(c.appEnv, 'staging');
    assert.equal(c.l27Mode, 'mock');
    assert.equal(c.notificationsMode, 'sandbox');
    assert.ok(c.warnings.length >= 2);
  });

  test('a local machine may read live Launch27 but never write to it outside production', () => {
    const c = loadConfig({ L27_ALLOW_WRITES: 'true' });
    assert.equal(c.l27Mode, 'live');
    assert.equal(c.allowWrites, false);
  });

  test('RingCentral is disabled outside production unless it points at the sandbox', () => {
    assert.equal(loadConfig({ APP_ENV: 'staging', RINGCENTRAL_CLIENT_ID: 'abc', RINGCENTRAL_SERVER: 'https://platform.ringcentral.com' }).ringcentralClientId, null);
    assert.equal(loadConfig({ APP_ENV: 'staging', RINGCENTRAL_CLIENT_ID: 'abc', RINGCENTRAL_SERVER: 'https://platform.devtest.ringcentral.com' }).ringcentralClientId, 'abc');
  });

  test('production refuses to start without a real secret and database', () => {
    const errs = configErrors(loadConfig({ APP_ENV: 'production' }));
    assert.ok(errs.some((e) => e.includes('SESSION_SECRET')));
    assert.ok(errs.some((e) => e.includes('DATABASE_URL')));
    assert.ok(errs.some((e) => e.includes('INBOX_SIMULATOR')) === false); // simulator defaults off in production
  });
});

describe('migrations', () => {
  test('apply once, are idempotent, and report status', async () => {
    const db = await openDb({ migrate: false });
    const first = await runMigrations(db);
    assert.deepEqual(first, loadMigrations().map((m) => m.name));
    assert.deepEqual(await runMigrations(db), []);
    assert.ok((await migrationStatus(db)).every((s) => s.state === 'applied'));
    await db.close();
  });

  test('an edited, already-applied migration stops the run', async () => {
    const db = await openDb({ migrate: false });
    const migrations = loadMigrations();
    await runMigrations(db, { migrations });
    const edited = migrations.map((m, i) => (i === 0 ? { ...m, checksum: 'different' } : m));
    await assert.rejects(runMigrations(db, { migrations: edited }), /were edited/);
    await db.close();
  });

  test('statement splitting ignores semicolons in comments', () => {
    assert.deepEqual(splitStatements('CREATE TABLE a (id int); -- note; here\nCREATE TABLE b (id int, -- x; y\n v int);'), ['CREATE TABLE a (id int)', 'CREATE TABLE b (id int, \n v int)']);
  });
});

describe('sessions', () => {
  test('persist encrypted and survive a restart', async () => {
    const db = await openDb();
    const a = new SessionStore({ db, secret: 'x'.repeat(40) });
    const id = a.create('bearer-123', 'Agent@Example.com');
    await new Promise((r) => setTimeout(r, 50));
    const row = (await db.query('SELECT * FROM sessions')).rows[0];
    assert.notEqual(row.id, id, 'raw id is not stored');
    assert.ok(!row.bearer_enc.includes('bearer-123'), 'token is encrypted');

    const b = new SessionStore({ db, secret: 'x'.repeat(40) }); // "after a redeploy"
    assert.equal(b.get(id), null);
    await b.hydrate(id);
    assert.equal(b.get(id).bearer, 'bearer-123');

    const wrongKey = new SessionStore({ db, secret: 'y'.repeat(40) });
    await wrongKey.hydrate(id);
    assert.equal(wrongKey.get(id), null, 'rotated secret signs everyone out');
    await db.close();
  });
});

describe('health endpoints', () => {
  test('/healthz is always up; /readyz checks the database and worker', async () => {
    const db = await openDb();
    const jobs = { consecutiveFailures: 0 };
    const config = loadConfig({ APP_ENV: 'staging' });
    const server = createApp(config, { db, jobs }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const h = await fetch(`${base}/healthz`);
      assert.equal(h.status, 200);
      assert.equal((await h.json()).env, 'staging');
      const r = await (await fetch(`${base}/readyz`)).json();
      assert.equal(r.status, 'ready');
      assert.equal(r.checks.database, 'ok');
      assert.equal(r.checks.migrations, 'ok');
      jobs.consecutiveFailures = 6;
      assert.equal((await fetch(`${base}/readyz`)).status, 503);
    } finally {
      server.close();
      await db.close();
    }
  });
});

describe('notifications guard', () => {
  test('sandbox connectors never call the provider', async () => {
    let called = false;
    const live = { sms: { name: 'twilio', send: async () => ((called = true), { id: '1' }) } };
    const res = await sendOutbound({ channel: 'sms', to: '+16135550100', body: 'hi' }, guardConnectors(live, 'sandbox'));
    assert.equal(res.state, 'sandbox');
    assert.equal(called, false);
    const sent = await sendOutbound({ channel: 'sms', to: '+16135550100', body: 'hi' }, guardConnectors(live, 'live'));
    assert.equal(sent.state, 'sent');
    assert.equal(called, true);
  });
});

describe('logging', () => {
  test('removes secrets and personal data', () => {
    const r = redact({ email: 'a@b.com', password: 'p', detail: 'call 613-555-0100 or x@y.ca', nested: { authorization: 'Bearer t' } });
    assert.equal(r.email, '[redacted]');
    assert.equal(r.password, '[secret]');
    assert.equal(r.detail, 'call [phone] or [email]');
    assert.equal(r.nested.authorization, '[secret]');
    const lines = [];
    createLogger({ write: (l) => lines.push(l) }).info('login for jo@example.com', { path: '/x' });
    assert.ok(!lines[0].includes('jo@example.com'));
  });
});

describe('synthetic Launch27', () => {
  const mock = createMockLaunch27({ password: 'demo', now: () => Date.parse('2026-11-02T20:00:00Z') });
  const call = (path, init = {}) => mock(`https://mock${path}`, { ...init, headers: { authorization: 'Bearer mock-bearer', ...(init.headers || {}) } });

  test('login needs the mock password', async () => {
    assert.equal((await mock('https://mock/latest/login', { method: 'POST', body: JSON.stringify({ email: 'a@example.com', password: 'nope' }) })).status, 401);
    const ok = await mock('https://mock/latest/login', { method: 'POST', body: JSON.stringify({ email: 'a@example.com', password: 'demo' }) });
    assert.equal((await ok.json()).bearer, 'mock-bearer');
  });

  test('serves deterministic, synthetic bookings with example.com contacts', async () => {
    const a = await (await call('/v1/staff/bookings?from=2026-11-02&to=2026-11-02')).json();
    const b = await (await call('/v1/staff/bookings?from=2026-11-02&to=2026-11-02')).json();
    assert.ok(a.length > 5);
    assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
    assert.ok(a.every((x) => x.user.email.endsWith('@example.com')));
    assert.ok(a.every((x) => /555-/.test(x.phone)));
  });

  test('writes apply to the in-memory overlay (assign, cancel, restore)', async () => {
    const [first] = await (await call('/v1/staff/bookings?from=2026-11-03&to=2026-11-03')).json();
    await call('/v1/staff/bookings/assign/teams', { method: 'POST', body: JSON.stringify({ booking_ids: [first.id], teams: [{ id: 9001, hours: 2, share: 22 }] }) });
    assert.equal((await (await call(`/v1/staff/bookings/${first.id}`)).json()).teams[0].id, 9001);
    await call(`/v1/staff/bookings/${first.id}/cancel`, { method: 'POST', body: '{}' });
    assert.equal((await (await call(`/v1/staff/bookings/${first.id}`)).json()).active, false);
    await call(`/v1/staff/bookings/${first.id}/restore`, { method: 'POST', body: '{}' });
    assert.equal((await (await call(`/v1/staff/bookings/${first.id}`)).json()).active, true);
  });

  test('requires the bearer token', async () => {
    assert.equal((await mock('https://mock/v1/staff/teams')).status, 401);
  });
});
