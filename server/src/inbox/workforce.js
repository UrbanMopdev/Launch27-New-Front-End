// Workforce: agent statuses, teams, capacity and workspace routing policies.
// Modelled on Kustomer's settings so the team keeps the same mental model:
//   Available  -> receives pushed work (up to capacity per channel)
//   Away       -> custom reasons (Busy, Break, Lunch, Meeting...), no new work; keeps or
//                 returns current work per status; optional time limit alerts supervisors
//   Offline    -> no work; open conversations go back to their queues

const one = async (q, sql, p) => (await q.query(sql, p)).rows[0] || null;
const many = async (q, sql, p) => (await q.query(sql, p)).rows;

export const CHANNELS = ['email', 'sms', 'chat', 'voice'];

export const DEFAULT_SETTINGS = {
  // Max open conversations per agent per channel, unless the agent has their own.
  default_capacity: { email: 10, sms: 6, chat: 3, voice: 1 },
  // Going offline hands open and snoozed work back to the queues (Kustomer's behaviour).
  offline_returns_work: true,
  // Set an agent offline after this many minutes without activity (0 = never).
  auto_offline_idle_minutes: 30,
  // Becoming available pulls waiting work from the agent's queues.
  pull_waiting_on_available: true,
  // Replying to an unassigned conversation assigns it to you.
  assign_on_reply: true,
  // A customer writing back to a done conversation goes to the agent who closed it, if
  // they're available and within the window; otherwise it's routed again.
  reopen_to_previous_owner: true,
  reopen_window_hours: 72,
  // Ask for audience / reason / outcome when marking a conversation done.
  require_disposition: true,
  // Tell supervisors when someone stays in a status past its time limit.
  alert_on_long_away: true,
};

export const DEFAULT_STATUSES = [
  { slug: 'available', name: 'Available', kind: 'available', color: '#15803d', keeps_work: true, max_minutes: null },
  { slug: 'busy', name: 'Busy', kind: 'away', color: '#b45309', keeps_work: true, max_minutes: null },
  { slug: 'break', name: 'Break', kind: 'away', color: '#f59e0b', keeps_work: true, max_minutes: 15 },
  { slug: 'lunch', name: 'Lunch', kind: 'away', color: '#f59e0b', keeps_work: true, max_minutes: 60 },
  { slug: 'meeting', name: 'Meeting', kind: 'away', color: '#6366f1', keeps_work: true, max_minutes: 90 },
  { slug: 'training', name: 'Training', kind: 'away', color: '#6366f1', keeps_work: true, max_minutes: null },
  { slug: 'wrap-up', name: 'Wrap-up', kind: 'away', color: '#0e7490', keeps_work: true, max_minutes: 10 },
  { slug: 'offline', name: 'Offline', kind: 'offline', color: '#6b7280', keeps_work: false, max_minutes: null },
];

export const DEFAULT_TEAMS = [
  { name: 'Customer care', description: 'Bookings, arrivals, changes, ratings', queues: ['operations', 'customer-success', 'fallback'] },
  { name: 'Sales', description: 'Quotes, new inquiries, lead follow-up', queues: ['sales'] },
  { name: 'Finance', description: 'Charges, declined cards, payroll', queues: ['billing', 'payroll'] },
  { name: 'People', description: 'Applicants, hiring and HR', queues: ['hiring', 'hr'] },
  { name: 'Management', description: 'Escalations and disputes', queues: ['management'] },
];

export const DEFAULT_SCHEDULES = [
  { name: 'UrbanMop office hours', time_zone: 'America/Toronto', is_default: true, week: { 0: ['09:00', '17:00'], 1: ['08:00', '20:00'], 2: ['08:00', '20:00'], 3: ['08:00', '20:00'], 4: ['08:00', '20:00'], 5: ['08:00', '20:00'], 6: ['08:00', '20:00'] } },
  { name: '24/7', time_zone: 'America/Toronto', is_default: false, week: { 0: ['00:00', '24:00'], 1: ['00:00', '24:00'], 2: ['00:00', '24:00'], 3: ['00:00', '24:00'], 4: ['00:00', '24:00'], 5: ['00:00', '24:00'], 6: ['00:00', '24:00'] } },
];

const presenceFor = (kind) => (kind === 'available' ? 'available' : kind === 'offline' ? 'offline' : 'busy');

// Idempotent: fills empty tables and missing setting keys only, never overwrites admin changes.
export async function seedWorkforce(db) {
  const count = async (t) => Number((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
  if (!(await count('agent_statuses'))) {
    for (const [i, s] of DEFAULT_STATUSES.entries()) {
      await db.query('INSERT INTO agent_statuses (slug, name, kind, color, keeps_work, max_minutes, position) VALUES ($1,$2,$3,$4,$5,$6,$7)', [s.slug, s.name, s.kind, s.color, s.keeps_work, s.max_minutes, i]);
    }
  }
  // Existing agents: carry their old presence over to a status.
  await db.query(`UPDATE users u SET status_id = s.id, status_since = COALESCE(u.presence_at, now())
                  FROM agent_statuses s WHERE u.status_id IS NULL AND s.slug = (CASE u.presence WHEN 'available' THEN 'available' WHEN 'busy' THEN 'busy' ELSE 'offline' END)`);
  if (!(await count('schedules'))) {
    for (const s of DEFAULT_SCHEDULES) await db.query('INSERT INTO schedules (name, time_zone, week, is_default) VALUES ($1,$2,$3::jsonb,$4)', [s.name, s.time_zone, JSON.stringify(s.week), s.is_default]);
  }
  if (!(await count('teams'))) {
    for (const [i, t] of DEFAULT_TEAMS.entries()) {
      const row = await one(db, 'INSERT INTO teams (name, description, position) VALUES ($1,$2,$3) RETURNING id', [t.name, t.description, i]);
      for (const slug of t.queues) await db.query('INSERT INTO queue_teams (queue_id, team_id) SELECT id, $2 FROM queues WHERE slug = $1 ON CONFLICT DO NOTHING', [slug, row.id]);
    }
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.query('INSERT INTO workspace_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value)]);
  }
}

export async function getSettings(q) {
  const rows = await many(q, 'SELECT key, value FROM workspace_settings');
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export function validateSettings(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${k}`);
    const def = DEFAULT_SETTINGS[k];
    if (typeof def === 'boolean') out[k] = !!v;
    else if (typeof def === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a number 0 or more`);
      out[k] = n;
    } else if (k === 'default_capacity') out[k] = normalizeCapacity(v, def);
  }
  return out;
}

export function normalizeCapacity(v, fallback = {}) {
  const out = {};
  for (const ch of CHANNELS) {
    const n = v?.[ch];
    if (n === undefined || n === null || n === '') {
      if (fallback[ch] !== undefined) out[ch] = fallback[ch];
      continue;
    }
    const num = Math.floor(Number(n));
    if (!Number.isFinite(num) || num < 0 || num > 99) throw new Error(`Capacity for ${ch} must be 0–99`);
    out[ch] = num;
  }
  return out;
}

// Effective capacity for one agent and channel.
export function capacityFor(user, channel, settings) {
  const own = user?.capacity?.[channel];
  if (own !== undefined && own !== null) return Number(own);
  return Number(settings.default_capacity?.[channel] ?? 99);
}

// Change an agent's status. Returns { status, requeued }.
// requeue(conversations) is supplied by the caller (service.js) to hand work back.
export async function setStatus(q, user, statusId, { by = 'self', requeue, pullWaiting } = {}) {
  const status = await one(q, 'SELECT * FROM agent_statuses WHERE id = $1', [statusId]);
  if (!status) throw Object.assign(new Error('Unknown status'), { status: 400 });
  if (by === 'self' && !status.selectable) throw Object.assign(new Error(`${status.name} can only be set by a supervisor`), { status: 403 });
  const settings = await getSettings(q);
  await q.query('UPDATE agent_status_log SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [user.id]);
  await q.query('INSERT INTO agent_status_log (user_id, status_id, set_by) VALUES ($1,$2,$3)', [user.id, status.id, by]);
  await q.query('UPDATE users SET status_id = $2, status_since = now(), status_alerted_at = NULL, presence = $3, presence_at = now() WHERE id = $1', [user.id, status.id, presenceFor(status.kind)]);
  let requeued = 0;
  const returnsWork = status.kind === 'offline' ? settings.offline_returns_work : status.kind === 'away' && !status.keeps_work;
  if (returnsWork && requeue) requeued = await requeue(q, user, `${user.name || user.email} is ${status.name.toLowerCase()}`);
  if (status.kind === 'available' && settings.pull_waiting_on_available && pullWaiting) await pullWaiting(q, user);
  return { status, presence: presenceFor(status.kind), requeued };
}

// People who could take a conversation from this queue right now, best first.
export async function eligibleAgents(q, conv) {
  const queue = await one(q, 'SELECT * FROM queues WHERE id = $1', [conv.queue_id]);
  if (!queue || queue.routing_mode === 'manual') return [];
  const settings = await getSettings(q);
  const rows = await many(
    q,
    `SELECT DISTINCT u.id, u.name, u.email, u.capacity, u.presence_at, u.last_assigned_at,
            (SELECT count(*)::int FROM conversations c WHERE c.owner_id = u.id AND c.status = 'open') AS load,
            (SELECT count(*)::int FROM conversations c WHERE c.owner_id = u.id AND c.status = 'open' AND c.channel = $2) AS channel_load
     FROM users u JOIN queue_agents a ON a.user_id = u.id
     WHERE a.queue_id = $1 AND u.presence = 'available' AND u.active`,
    [conv.queue_id, conv.channel],
  );
  const open = rows.filter((u) => u.channel_load < capacityFor(u, conv.channel, settings));
  const t = (d) => (d ? new Date(d).getTime() : 0);
  return open.sort((a, b) =>
    queue.routing_mode === 'round_robin'
      ? t(a.last_assigned_at) - t(b.last_assigned_at) || Number(a.id) - Number(b.id)
      : a.load - b.load || t(a.presence_at) - t(b.presence_at) || Number(a.id) - Number(b.id),
  );
}

// Background checks: queue overflow, too-long away statuses, idle agents going offline.
export async function workforceTick(q, { now = new Date(), notify, event, autoAssign, requeue, supervisors } = {}) {
  const settings = await getSettings(q);
  // Overflow: unassigned past the queue's limit moves to its overflow queue (once).
  const over = await many(
    q,
    `SELECT c.*, qu.name AS from_queue, oq.name AS to_queue FROM conversations c
       JOIN queues qu ON qu.id = c.queue_id JOIN queues oq ON oq.id = qu.overflow_queue_id
     WHERE c.status = 'open' AND c.owner_id IS NULL AND c.overflowed_at IS NULL AND qu.overflow_minutes IS NOT NULL
       AND COALESCE(c.awaiting_reply_since, c.created_at) <= $1::timestamptz - make_interval(mins => qu.overflow_minutes)`,
    [now],
  );
  for (const c of over) {
    const moved = await one(q, 'UPDATE conversations c SET queue_id = qu.overflow_queue_id, overflowed_at = $2, updated_at = now() FROM queues qu WHERE qu.id = c.queue_id AND c.id = $1 RETURNING c.*', [c.id, now]);
    if (event) await event(q, c.id, `Moved from ${c.from_queue} to ${c.to_queue}: nobody picked it up in time`, { type: 'overflow' });
    if (moved && autoAssign) await autoAssign(q, moved);
  }

  // Too long in a status (e.g. a 15-minute break at 25 minutes): tell supervisors once.
  let alerted = 0;
  if (settings.alert_on_long_away) {
    const long = await many(
      q,
      `SELECT u.id, u.name, u.email, s.name AS status, s.max_minutes FROM users u JOIN agent_statuses s ON s.id = u.status_id
       WHERE s.max_minutes IS NOT NULL AND u.status_alerted_at IS NULL AND u.status_since <= $1::timestamptz - make_interval(mins => s.max_minutes)`,
      [now],
    );
    for (const u of long) {
      await q.query('UPDATE users SET status_alerted_at = $2 WHERE id = $1', [u.id, now]);
      for (const s of supervisors ? await supervisors(q) : []) if (notify) await notify(q, s.id, 'status_overdue', null, `${u.name || u.email} has been on ${u.status} for over ${u.max_minutes} min`);
      alerted++;
    }
  }

  // Idle: available or away, no activity for N minutes -> offline (returns work).
  let idled = 0;
  if (settings.auto_offline_idle_minutes > 0) {
    const offline = await one(q, "SELECT * FROM agent_statuses WHERE kind = 'offline' ORDER BY position LIMIT 1");
    const idle = await many(
      q,
      `SELECT u.* FROM users u JOIN agent_statuses s ON s.id = u.status_id
       WHERE s.kind <> 'offline' AND u.last_seen_at IS NOT NULL AND u.last_seen_at <= $1::timestamptz - make_interval(mins => $2::int)`,
      [now, settings.auto_offline_idle_minutes],
    );
    for (const u of idle) {
      if (offline) await setStatus(q, u, offline.id, { by: 'auto', requeue });
      idled++;
    }
  }
  return { overflowed: over.length, alerted, idled };
}
