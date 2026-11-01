import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { seed, UM } from '../src/inbox/seed.js';
import * as svc from '../src/inbox/service.js';
import { capacityFor, normalizeCapacity, validateSettings, DEFAULT_SETTINGS } from '../src/inbox/workforce.js';

describe('workforce: statuses, teams, capacity, routing modes', () => {
  let db;
  let ana;
  let ben;
  let boss;
  const t0 = new Date('2026-11-02T10:00:00-05:00');
  let phone = 100;
  const status = async (slug) => (await db.query('SELECT id FROM agent_statuses WHERE slug = $1', [slug])).rows[0].id;
  const setStatus = async (u, slug) => {
    const id = await status(slug);
    return db.tx((q) => svc.setStatus(q, u, id));
  };
  const text = (body = 'Hi', at = t0) => db.tx((q) => svc.ingestInbound(q, { channel: 'sms', from: `613-555-0${phone++}`, to: UM.smsOttawa, body }, { now: at }));
  const owner = async (r) => (await db.query('SELECT owner_id FROM conversations WHERE id = $1', [r.conversationId])).rows[0].owner_id;
  const opsId = async () => (await db.query("SELECT id FROM queues WHERE slug = 'operations'")).rows[0].id;
  const resetWork = () => db.query("UPDATE conversations SET status = 'done', owner_id = NULL");

  before(async () => {
    db = await openDb();
    await seed(db);
    const mk = async (email, name, role = 'agent') => (await db.query('INSERT INTO users (email, name, role) VALUES ($1,$2,$3) RETURNING *', [email, name, role])).rows[0];
    ana = await mk('ana@example.com', 'Ana');
    ben = await mk('ben@example.com', 'Ben');
    boss = await mk('boss@example.com', 'Boss', 'supervisor');
    // Ana and Ben work Operations through the Customer care team, not direct membership.
    const team = (await db.query("SELECT id FROM teams WHERE name = 'Customer care'")).rows[0].id;
    for (const u of [ana, ben]) await db.query('INSERT INTO team_members (team_id, user_id) VALUES ($1,$2)', [team, u.id]);
  });
  after(() => db.close());

  test('seeded defaults: Kustomer-style statuses, teams serving queues, office hours, policies', async () => {
    const statuses = (await db.query('SELECT slug, kind FROM agent_statuses ORDER BY position')).rows;
    assert.deepEqual(statuses.map((s) => s.slug), ['available', 'busy', 'break', 'lunch', 'meeting', 'training', 'wrap-up', 'offline']);
    const ops = (await db.query("SELECT count(*)::int AS n FROM queue_agents a JOIN queues q ON q.id = a.queue_id WHERE q.slug = 'operations'")).rows[0].n;
    assert.equal(ops, 2, 'team members work the queue');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM schedules WHERE is_default')).rows[0].n, 1);
    assert.equal((await db.query("SELECT value FROM workspace_settings WHERE key = 'offline_returns_work'")).rows[0].value, true);
  });

  test('only Available agents get work; Break keeps current work but takes no new work', async () => {
    await setStatus(ana, 'available');
    const r1 = await text();
    assert.equal(Number(await owner(r1)), Number(ana.id));
    await setStatus(ana, 'break');
    const r2 = await text();
    assert.equal(await owner(r2), null, 'nobody available');
    assert.equal(Number(await owner(r1)), Number(ana.id), 'Break keeps assigned work');
    await setStatus(ana, 'available');
    assert.equal(Number(await owner(r2)), Number(ana.id), 'coming back pulls waiting work');
  });

  test('Offline hands work back to the queue', async () => {
    const r = await setStatus(ana, 'offline');
    assert.ok(r.requeued >= 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM conversations WHERE owner_id = $1 AND status = $2', [ana.id, 'open'])).rows[0].n, 0);
  });

  test('capacity per channel: a full agent is skipped', async () => {
    await resetWork();
    await db.query(`UPDATE users SET capacity = '{"sms": 1}' WHERE id = $1`, [ana.id]);
    await setStatus(ana, 'available');
    const a = await text();
    const b = await text();
    assert.equal(Number(await owner(a)), Number(ana.id));
    assert.equal(await owner(b), null, 'Ana is at her text capacity');
    await db.query(`UPDATE users SET capacity = '{}' WHERE id = $1`, [ana.id]);
  });

  test('least busy vs round robin', async () => {
    await resetWork();
    await setStatus(ben, 'available');
    // Least busy: Ana has 0, Ben has 0 -> earliest available (Ana); then Ben (Ana has 1).
    const a = await text();
    const b = await text();
    assert.notEqual(Number(await owner(a)), Number(await owner(b)));
    // Round robin ignores load and takes turns by last assignment.
    await resetWork();
    await db.query("UPDATE queues SET routing_mode = 'round_robin' WHERE slug = 'operations'");
    const owners = [];
    for (let i = 0; i < 4; i++) owners.push(Number(await owner(await text())));
    assert.deepEqual(owners.slice(2), owners.slice(0, 2), 'alternates');
    // Manual: nothing is pushed.
    await db.query("UPDATE queues SET routing_mode = 'manual' WHERE slug = 'operations'");
    assert.equal(await owner(await text()), null);
    await db.query("UPDATE queues SET routing_mode = 'least_busy' WHERE slug = 'operations'");
  });

  test('overflow moves unpicked conversations to another queue once', async () => {
    await resetWork();
    for (const u of [ana, ben]) await setStatus(u, 'offline');
    const mgmt = (await db.query("SELECT id FROM queues WHERE slug = 'management'")).rows[0].id;
    await db.query('UPDATE queues SET overflow_minutes = 30, overflow_queue_id = $2 WHERE id = $1', [await opsId(), mgmt]);
    const r = await text('Help', t0);
    await db.tx((q) => svc.tick(q, new Date(t0.getTime() + 31 * 60_000)));
    const c = (await db.query('SELECT queue_id, overflowed_at FROM conversations WHERE id = $1', [r.conversationId])).rows[0];
    assert.equal(Number(c.queue_id), Number(mgmt));
    assert.ok(c.overflowed_at);
    await db.query('UPDATE queues SET overflow_minutes = NULL, overflow_queue_id = NULL WHERE id = $1', [await opsId()]);
  });

  test('a break past its limit alerts supervisors once; idle agents go offline', async () => {
    await setStatus(ben, 'break'); // 15-minute limit
    const later = new Date(Date.now() + 16 * 60_000);
    await db.tx((q) => svc.tick(q, later));
    await db.tx((q) => svc.tick(q, later));
    const alerts = (await db.query("SELECT text FROM notifications WHERE user_id = $1 AND kind = 'status_overdue'", [boss.id])).rows;
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].text, /Ben has been on Break for over 15 min/);

    await setStatus(ana, 'available');
    await db.query("UPDATE users SET last_seen_at = now() - interval '45 minutes' WHERE id = $1", [ana.id]);
    await db.tx((q) => svc.tick(q, new Date()));
    const s = (await db.query('SELECT s.slug FROM users u JOIN agent_statuses s ON s.id = u.status_id WHERE u.id = $1', [ana.id])).rows[0];
    assert.equal(s.slug, 'offline');
  });

  test('status time is logged for reporting', async () => {
    const log = (await db.query('SELECT count(*)::int AS n FROM agent_status_log WHERE user_id = $1', [ana.id])).rows[0].n;
    assert.ok(log >= 4);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_status_log WHERE user_id = $1 AND ended_at IS NULL', [ana.id])).rows[0].n, 1);
  });

  test('settings and capacity validation', () => {
    assert.deepEqual(validateSettings({ auto_offline_idle_minutes: '20', assign_on_reply: 0 }), { auto_offline_idle_minutes: 20, assign_on_reply: false });
    assert.throws(() => validateSettings({ nope: 1 }), /Unknown setting/);
    assert.throws(() => validateSettings({ reopen_window_hours: -1 }), /0 or more/);
    assert.deepEqual(normalizeCapacity({ sms: '4', chat: '' }), { sms: 4 });
    assert.throws(() => normalizeCapacity({ email: 500 }), /0–99/);
    assert.equal(capacityFor({ capacity: { sms: 2 } }, 'sms', DEFAULT_SETTINGS), 2);
    assert.equal(capacityFor({ capacity: {} }, 'chat', DEFAULT_SETTINGS), 3);
  });
});
