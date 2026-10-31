// /api: the support workspace. Every route needs a signed-in agent (same Launch27 login
// as the rest of the app); the agent's Launch27 token is used for lookups so Launch27
// keeps enforcing their permissions.
import express from 'express';
import { json as toJson } from '../db/index.js';
import { lintRules, route } from './routing.js';
import { DISPOSITIONS, OUR_IDENTITIES, UM } from './seed.js';
import { connectedChannels } from './channels.js';
import { normalizeEmail, normalizeIdentity, normalizePhone, kindForChannel } from './normalize.js';
import * as svc from './service.js';

const one = async (q, sql, p) => (await q.query(sql, p)).rows[0] || null;
const many = async (q, sql, p) => (await q.query(sql, p)).rows;

export function createInboxRouter({ db, sessions, cookieName, config, l27, connectors = {}, log = (lvl, msg, f) => console.error(msg, f) }) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  const roleFor = (email, isFirst) => {
    const list = (v) => String(v || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (list(config.adminEmails).includes(email) || isFirst) return 'admin';
    if (list(config.supervisorEmails).includes(email)) return 'supervisor';
    return 'agent';
  };

  // Signed-in agent -> users row (created on first visit).
  r.use(async (req, res, next) => {
    try {
      const session = sessions.get(req.signedCookies[cookieName]);
      if (!session) return res.status(401).json({ error: 'Not logged in' });
      const email = session.email.toLowerCase();
      let user = await one(db, 'UPDATE users SET last_seen_at = now() WHERE email = $1 RETURNING *', [email]);
      if (!user) {
        const isFirst = !(await one(db, 'SELECT 1 FROM users LIMIT 1'));
        user = await one(db, 'INSERT INTO users (email, name, role) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET last_seen_at = now() RETURNING *', [email, email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), roleFor(email, isFirst)]);
        // New agents start in Operations; admins add other queues.
        await db.query("INSERT INTO queue_members (queue_id, user_id) SELECT id, $1 FROM queues WHERE slug = 'operations' ON CONFLICT DO NOTHING", [user.id]);
      }
      req.user = user;
      req.bearer = session.bearer;
      next();
    } catch (err) {
      next(err);
    }
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const needRole = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Your role cannot do this' }));
  const isLead = (u) => u.role === 'admin' || u.role === 'supervisor';

  // Queues the user may see: open queues, plus restricted ones they belong to (admins see all).
  const visibleQueueIds = async (user) =>
    (await many(db, 'SELECT q.id FROM queues q WHERE NOT q.restricted OR $2 OR EXISTS (SELECT 1 FROM queue_members m WHERE m.queue_id = q.id AND m.user_id = $1)', [user.id, user.role === 'admin'])).map((x) => Number(x.id));

  const canSee = async (user, conv) => !conv.queue_id || conv.owner_id === user.id || (await visibleQueueIds(user)).includes(Number(conv.queue_id));

  async function loadConversation(req, id) {
    const conv = await one(db, 'SELECT * FROM conversations WHERE id = $1', [id]);
    if (!conv) throw new svc.InboxError(404, 'Conversation not found');
    if (!(await canSee(req.user, conv))) throw new svc.InboxError(403, 'This conversation is in a restricted queue');
    return conv;
  }

  // ---------- me, users, meta ----------

  r.get('/me', wrap(async (req, res) => {
    const queues = await many(db, 'SELECT q.id, q.slug, q.name FROM queues q JOIN queue_members m ON m.queue_id = q.id WHERE m.user_id = $1 ORDER BY q.position', [req.user.id]);
    res.json({ ...req.user, queues });
  }));

  r.put('/me/presence', wrap(async (req, res) => {
    res.json(await db.tx((q) => svc.setPresence(q, req.user, req.body?.presence)));
  }));

  r.patch('/me', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) throw new svc.InboxError(400, 'Name is required');
    res.json(await one(db, 'UPDATE users SET name = $2 WHERE id = $1 RETURNING *', [req.user.id, name]));
  }));

  r.get('/users', wrap(async (req, res) => {
    res.json(await many(db, `SELECT u.id, u.email, u.name, u.role, u.presence, u.last_seen_at,
      (SELECT count(*)::int FROM conversations c WHERE c.owner_id = u.id AND c.status = 'open') AS open_count,
      COALESCE((SELECT json_agg(m.queue_id) FROM queue_members m WHERE m.user_id = u.id), '[]') AS queue_ids
      FROM users u ORDER BY u.name`));
  }));

  r.patch('/users/:id', needRole('admin'), wrap(async (req, res) => {
    const { role, queue_ids, name } = req.body || {};
    await db.tx(async (q) => {
      if (role) {
        if (!['agent', 'supervisor', 'admin'].includes(role)) throw new svc.InboxError(400, 'Unknown role');
        await q.query('UPDATE users SET role = $2 WHERE id = $1', [req.params.id, role]);
      }
      if (name) await q.query('UPDATE users SET name = $2 WHERE id = $1', [req.params.id, name]);
      if (Array.isArray(queue_ids)) {
        await q.query('DELETE FROM queue_members WHERE user_id = $1', [req.params.id]);
        for (const qid of queue_ids) await q.query('INSERT INTO queue_members (queue_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [qid, req.params.id]);
      }
      await svc.audit(q, req.user.id, 'user.updated', 'user', req.params.id, { role, queue_ids, name });
    });
    res.json(await one(db, 'SELECT * FROM users WHERE id = $1', [req.params.id]));
  }));

  r.get('/meta', wrap(async (req, res) => {
    const visible = await visibleQueueIds(req.user);
    res.json({
      queues: (await many(db, 'SELECT * FROM queues ORDER BY position')).filter((q) => visible.includes(Number(q.id))),
      sla_policies: await many(db, 'SELECT * FROM sla_policies ORDER BY first_response_minutes'),
      dispositions: DISPOSITIONS,
      canned: await many(db, 'SELECT * FROM canned_responses ORDER BY shortcut'),
      identities: OUR_IDENTITIES,
      connected_channels: connectedChannels(connectors),
      ringcentral: config.ringcentralClientId ? { clientId: config.ringcentralClientId, appServer: config.ringcentralServer || null } : null,
      holidays: await many(db, "SELECT to_char(day,'YYYY-MM-DD') AS day, name FROM holidays ORDER BY day"),
    });
  }));

  // ---------- work lists ----------

  r.get('/conversations', wrap(async (req, res) => {
    const { view = 'mine', status = 'open', channel, role, q: text, contact_id, booking_id, limit = 100 } = req.query;
    const visible = await visibleQueueIds(req.user);
    const where = ['(c.queue_id IS NULL OR c.queue_id = ANY($1::bigint[]) OR c.owner_id = $2)'];
    const params = [visible, req.user.id];
    const add = (sql, v) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (status !== 'all') add('c.status = ?', status);
    if (view === 'mine') add('c.owner_id = ?', req.user.id);
    else if (view === 'unassigned') where.push('c.owner_id IS NULL');
    else if (view === 'breached') where.push('c.sla_breached_at IS NOT NULL');
    else if (view === 'needs_match') where.push('c.needs_match');
    else if (view === 'mentions') add('EXISTS (SELECT 1 FROM notifications n WHERE n.conversation_id = c.id AND n.user_id = ? AND n.kind = \'mention\' AND n.read_at IS NULL)', req.user.id);
    else if (String(view).startsWith('queue:')) add('c.queue_id = ?', Number(String(view).slice(6)));
    if (channel) add('c.channel = ?', channel);
    if (role) add('co.roles @> ?::jsonb', JSON.stringify([role]));
    if (contact_id) add('c.contact_id = ?', Number(contact_id));
    if (booking_id) add('c.l27_booking_id = ?', Number(booking_id));
    if (text) {
      params.push(`%${text}%`);
      const n = `$${params.length}`;
      where.push(`(co.name ILIKE ${n} OR c.their_identity ILIKE ${n} OR c.subject ILIKE ${n} OR c.last_preview ILIKE ${n})`);
    }
    params.push(Math.min(Number(limit) || 100, 500));
    const rows = await many(
      db,
      `SELECT c.id, c.channel, c.status, c.subject, c.last_preview, c.last_message_at, c.priority, c.sla_due_at, c.sla_breached_at,
              c.awaiting_reply_since, c.l27_booking_id, c.needs_match, c.their_identity, c.our_identity, c.snooze_until,
              c.queue_id, qu.name AS queue_name, c.owner_id, u.name AS owner_name, c.contact_id, co.name AS contact_name, co.roles AS contact_roles,
              c.complaint IS NOT NULL AS has_complaint
       FROM conversations c
       LEFT JOIN contacts co ON co.id = c.contact_id
       LEFT JOIN queues qu ON qu.id = c.queue_id
       LEFT JOIN users u ON u.id = c.owner_id
       WHERE ${where.join(' AND ')}
       ORDER BY (c.sla_due_at IS NULL), c.sla_due_at ASC, c.priority DESC, c.last_message_at DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json(rows);
  }));

  r.get('/counts', wrap(async (req, res) => {
    const visible = await visibleQueueIds(req.user);
    const row = await one(
      db,
      `SELECT
        count(*) FILTER (WHERE c.owner_id = $2)::int AS mine,
        count(*) FILTER (WHERE c.owner_id IS NULL)::int AS unassigned,
        count(*) FILTER (WHERE c.sla_breached_at IS NOT NULL)::int AS breached,
        count(*) FILTER (WHERE c.needs_match)::int AS needs_match
       FROM conversations c WHERE c.status = 'open' AND (c.queue_id = ANY($1::bigint[]) OR c.owner_id = $2 OR c.queue_id IS NULL)`,
      [visible, req.user.id],
    );
    const byQueue = await many(db, "SELECT queue_id, count(*)::int AS n FROM conversations WHERE status = 'open' AND queue_id = ANY($1::bigint[]) GROUP BY queue_id", [visible]);
    const mentions = await one(db, "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'mention' AND read_at IS NULL", [req.user.id]);
    res.json({ ...row, mentions: mentions.n, queues: Object.fromEntries(byQueue.map((b) => [b.queue_id, b.n])) });
  }));

  // ---------- one conversation ----------

  r.get('/conversations/:id', wrap(async (req, res) => {
    const conv = await loadConversation(req, req.params.id);
    const [messages, contact, identities, others, queue, owner, policy] = await Promise.all([
      many(db, 'SELECT m.*, u.name AS author_name FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.conversation_id = $1 ORDER BY m.created_at, m.id', [conv.id]),
      conv.contact_id ? one(db, 'SELECT * FROM contacts WHERE id = $1', [conv.contact_id]) : null,
      conv.contact_id ? many(db, 'SELECT * FROM contact_identities WHERE contact_id = $1 ORDER BY kind, id', [conv.contact_id]) : [],
      conv.contact_id ? many(db, 'SELECT id, channel, status, subject, last_preview, last_message_at, l27_booking_id FROM conversations WHERE contact_id = $1 AND id <> $2 ORDER BY last_message_at DESC LIMIT 30', [conv.contact_id, conv.id]) : [],
      conv.queue_id ? one(db, 'SELECT * FROM queues WHERE id = $1', [conv.queue_id]) : null,
      conv.owner_id ? one(db, 'SELECT id, name, email, presence FROM users WHERE id = $1', [conv.owner_id]) : null,
      conv.sla_policy_id ? one(db, 'SELECT * FROM sla_policies WHERE id = $1', [conv.sla_policy_id]) : null,
    ]);
    const candidates = conv.needs_match
      ? await many(db, 'SELECT DISTINCT c.* FROM contacts c JOIN contact_identities i ON i.contact_id = c.id WHERE i.value = $1', [conv.their_identity])
      : [];
    await db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND conversation_id = $2 AND read_at IS NULL", [req.user.id, conv.id]);
    res.json({ conversation: conv, messages, contact: contact && { ...contact, identities }, others, queue, owner, sla_policy: policy, candidates });
  }));

  r.post('/conversations/:id/messages', wrap(async (req, res) => {
    await loadConversation(req, req.params.id);
    res.status(201).json(await db.tx((q) => svc.reply(q, req.user, req.params.id, req.body || {}, { connectors })));
  }));

  r.post('/conversations/:id/notes', wrap(async (req, res) => {
    await loadConversation(req, req.params.id);
    res.status(201).json(await db.tx((q) => svc.addNote(q, req.user, req.params.id, req.body?.body)));
  }));

  // System lines for things done elsewhere, e.g. "Rescheduled booking #123 to Thu 1pm".
  r.post('/conversations/:id/events', wrap(async (req, res) => {
    await loadConversation(req, req.params.id);
    const text = String(req.body?.text || '').trim();
    if (!text) throw new svc.InboxError(400, 'Event text is required');
    res.status(201).json(await db.tx((q) => svc.addEvent(q, req.user, req.params.id, text, req.body?.meta || {})));
  }));

  r.patch('/conversations/:id', wrap(async (req, res) => {
    await loadConversation(req, req.params.id);
    res.json(await db.tx((q) => svc.updateConversation(q, req.user, req.params.id, req.body || {})));
  }));

  r.post('/conversations/:id/claim', wrap(async (req, res) => {
    await loadConversation(req, req.params.id);
    res.json(await db.tx((q) => svc.claim(q, req.user, req.params.id)));
  }));

  r.post('/conversations/:id/assign', wrap(async (req, res) => {
    const conv = await loadConversation(req, req.params.id);
    if (!isLead(req.user) && conv.owner_id && conv.owner_id !== req.user.id) throw new svc.InboxError(403, 'Only the owner or a supervisor can reassign this');
    res.json(await db.tx((q) => svc.assign(q, req.user, req.params.id, req.body?.user_id || null, req.body?.reason || null)));
  }));

  // Start a conversation with someone (agent-initiated: text a cleaner, email a customer).
  r.post('/conversations', wrap(async (req, res) => {
    const { contact_id, channel = 'sms', to, from, subject, body, l27_booking_id } = req.body || {};
    if (!['email', 'sms'].includes(channel)) throw new svc.InboxError(400, 'Start conversations by email or text');
    const out = await db.tx(async (q) => {
      const contact = await one(q, 'SELECT * FROM contacts WHERE id = $1', [contact_id]);
      if (!contact) throw new svc.InboxError(404, 'Contact not found');
      const kind = kindForChannel(channel);
      const target = normalizeIdentity(kind, to) || (await one(q, 'SELECT value FROM contact_identities WHERE contact_id = $1 AND kind = $2 ORDER BY id LIMIT 1', [contact.id, kind]))?.value;
      if (!target) throw new svc.InboxError(400, `${contact.name || 'This contact'} has no ${kind === 'email' ? 'email address' : 'phone number'}`);
      const ours = from || (channel === 'email' ? UM.info : UM.smsOttawa);
      const queue = await one(q, 'SELECT id FROM queues WHERE slug = $1', [(contact.roles || []).includes('applicant') ? 'hiring' : 'operations']);
      const conv = await one(q, "INSERT INTO conversations (contact_id, channel, our_identity, their_identity, subject, queue_id, owner_id, l27_booking_id, routed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Started by agent') RETURNING *", [contact.id, channel, channel === 'email' ? normalizeEmail(ours) : normalizePhone(ours), target, subject || null, queue?.id, req.user.id, l27_booking_id || null]);
      if (body) await svc.reply(q, req.user, conv.id, { body, channel, to: target, subject, from: conv.our_identity }, { connectors });
      return conv;
    });
    res.status(201).json(out);
  }));

  // ---------- contacts ----------

  r.get('/contacts', wrap(async (req, res) => {
    const text = String(req.query.q || '').trim();
    if (!text) return res.json([]);
    const phone = normalizePhone(text);
    const rows = await many(
      db,
      `SELECT c.*, COALESCE((SELECT json_agg(i ORDER BY i.kind) FROM contact_identities i WHERE i.contact_id = c.id), '[]') AS identities
       FROM contacts c
       WHERE c.name ILIKE $1 OR EXISTS (SELECT 1 FROM contact_identities i WHERE i.contact_id = c.id AND (i.value ILIKE $1 OR i.value = $2))
          OR c.l27_customer_id::text = $3 OR c.l27_team_id::text = $3
       ORDER BY c.updated_at DESC LIMIT 25`,
      [`%${text}%`, phone, text],
    );
    res.json(rows);
  }));

  r.get('/contacts/:id', wrap(async (req, res) => {
    const contact = await one(db, 'SELECT * FROM contacts WHERE id = $1', [req.params.id]);
    if (!contact) throw new svc.InboxError(404, 'Contact not found');
    const visible = await visibleQueueIds(req.user);
    const [identities, conversations] = await Promise.all([
      many(db, 'SELECT * FROM contact_identities WHERE contact_id = $1 ORDER BY kind, id', [contact.id]),
      many(db, 'SELECT id, channel, status, subject, last_preview, last_message_at, l27_booking_id, queue_id, owner_id, disposition, complaint FROM conversations WHERE contact_id = $1 AND (queue_id IS NULL OR queue_id = ANY($2::bigint[]) OR owner_id = $3) ORDER BY last_message_at DESC LIMIT 100', [contact.id, visible, req.user.id]),
    ]);
    res.json({ ...contact, identities, conversations });
  }));

  r.post('/contacts', wrap(async (req, res) => {
    const { name, roles = ['customer'], email, phone } = req.body || {};
    const identities = [email && { kind: 'email', value: email }, phone && { kind: 'phone', value: phone }].filter(Boolean);
    if (!identities.length) throw new svc.InboxError(400, 'Add an email or phone number');
    const contact = await db.tx(async (q) => {
      const c = await svc.createContact(q, { name, roles, identities });
      await svc.audit(q, req.user.id, 'contact.created', 'contact', c.id, { name, roles });
      return c;
    });
    res.status(201).json(contact);
  }));

  r.patch('/contacts/:id', wrap(async (req, res) => {
    const allowed = ['name', 'roles', 'lead_stage', 'lead_source', 'communication_preference', 'notes', 'l27_customer_id', 'l27_team_id'];
    const sets = [];
    const params = [req.params.id];
    for (const k of allowed) {
      if (req.body?.[k] === undefined) continue;
      params.push(k === 'roles' ? toJson(req.body[k]) : req.body[k]);
      sets.push(`${k} = $${params.length}${k === 'roles' ? '::jsonb' : ''}`);
    }
    if (!sets.length) throw new svc.InboxError(400, 'Nothing to change');
    const updated = await db.tx(async (q) => {
      const row = await one(q, `UPDATE contacts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
      if (!row) throw new svc.InboxError(404, 'Contact not found');
      await svc.audit(q, req.user.id, 'contact.updated', 'contact', req.params.id, req.body);
      return row;
    });
    res.json(updated);
  }));

  r.post('/contacts/:id/identities', wrap(async (req, res) => {
    const { kind, value, label } = req.body || {};
    if (!['email', 'phone'].includes(kind)) throw new svc.InboxError(400, 'kind must be email or phone');
    const row = await db.tx((q) => svc.addIdentity(q, req.params.id, kind, value, label));
    if (!row) throw new svc.InboxError(400, `That doesn't look like a valid ${kind}`);
    res.status(201).json(row);
  }));

  r.patch('/identities/:id', wrap(async (req, res) => {
    const optedOut = !!req.body?.opted_out;
    const row = await db.tx(async (q) => {
      const r2 = await one(q, 'UPDATE contact_identities SET opted_out = $2, opted_out_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1 RETURNING *', [req.params.id, optedOut]);
      await svc.audit(q, req.user.id, optedOut ? 'identity.opted_out' : 'identity.opted_in', 'identity', req.params.id);
      return r2;
    });
    res.json(row);
  }));

  // Open the workspace contact for a Launch27 customer or cleaner, creating it on first use.
  r.post('/contacts/from-l27', wrap(async (req, res) => {
    const { customer_id, team_id } = req.body || {};
    if (!customer_id && !team_id) throw new svc.InboxError(400, 'customer_id or team_id is required');
    const col = customer_id ? 'l27_customer_id' : 'l27_team_id';
    const id = Number(customer_id || team_id);
    const existing = await one(db, `SELECT * FROM contacts WHERE ${col} = $1 ORDER BY id LIMIT 1`, [id]);
    if (existing) return res.json(existing);
    const info = customer_id ? await l27.customer(req.bearer, id) : await l27.team(req.bearer, id);
    const contact = await db.tx(async (q) => {
      // A person who already wrote in (matched by phone or email) gets linked instead of duplicated.
      for (const ident of info.identities) {
        const kind = ident.kind;
        const found = await svc.contactsByIdentity(q, kind, normalizeIdentity(kind, ident.value));
        if (found.length === 1) {
          const roles = [...new Set([...(found[0].roles || []), ...info.roles])];
          const linked = await one(q, `UPDATE contacts SET ${col} = $2, roles = $3::jsonb, name = COALESCE(name, $4), updated_at = now() WHERE id = $1 RETURNING *`, [found[0].id, id, toJson(roles), info.name]);
          for (const i of info.identities) await svc.addIdentity(q, linked.id, i.kind, i.value, i.label);
          return linked;
        }
      }
      return svc.createContact(q, info);
    });
    res.status(201).json(contact);
  }));

  // Link an unknown or ambiguous conversation to the right contact.
  r.post('/conversations/:id/match', wrap(async (req, res) => {
    await loadConversation(req, req.params.id);
    res.json(await db.tx((q) => svc.updateConversation(q, req.user, req.params.id, { contact_id: Number(req.body?.contact_id) })));
  }));

  // ---------- search, notifications ----------

  r.get('/search', wrap(async (req, res) => {
    const text = String(req.query.q || '').trim();
    if (text.length < 2) return res.json({ contacts: [], conversations: [] });
    const visible = await visibleQueueIds(req.user);
    const phone = normalizePhone(text);
    const [contacts, conversations] = await Promise.all([
      many(db, `SELECT c.id, c.name, c.roles, c.l27_customer_id, c.l27_team_id,
                 (SELECT string_agg(value, ', ') FROM contact_identities i WHERE i.contact_id = c.id) AS identities
               FROM contacts c WHERE c.name ILIKE $1 OR c.l27_customer_id::text = $3 OR c.l27_team_id::text = $3
                 OR EXISTS (SELECT 1 FROM contact_identities i WHERE i.contact_id = c.id AND (i.value ILIKE $1 OR i.value = $2))
               ORDER BY c.updated_at DESC LIMIT 10`, [`%${text}%`, phone, text]),
      many(db, `SELECT DISTINCT ON (c.id) c.id, c.channel, c.status, c.subject, c.last_message_at, co.name AS contact_name, m.body AS snippet
               FROM conversations c LEFT JOIN contacts co ON co.id = c.contact_id
               JOIN messages m ON m.conversation_id = c.id
               WHERE (c.queue_id IS NULL OR c.queue_id = ANY($2::bigint[]))
                 AND (m.body ILIKE $1 OR c.subject ILIKE $1 OR c.id::text = $3 OR c.l27_booking_id::text = $3)
               ORDER BY c.id DESC, m.created_at DESC LIMIT 20`, [`%${text}%`, visible, text]),
    ]);
    res.json({ contacts, conversations });
  }));

  r.get('/notifications', wrap(async (req, res) => {
    res.json(await many(db, 'SELECT n.*, co.name AS contact_name FROM notifications n LEFT JOIN conversations c ON c.id = n.conversation_id LEFT JOIN contacts co ON co.id = c.contact_id WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 50', [req.user.id]));
  }));

  r.post('/notifications/read', wrap(async (req, res) => {
    await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
    res.status(204).end();
  }));

  // ---------- supervisor ----------

  r.get('/supervisor', needRole('supervisor', 'admin'), wrap(async (req, res) => {
    const queues = await many(db, `SELECT q.id, q.name, q.slug,
        count(c.id) FILTER (WHERE c.status = 'open')::int AS open,
        count(c.id) FILTER (WHERE c.status = 'open' AND c.owner_id IS NULL)::int AS unassigned,
        count(c.id) FILTER (WHERE c.status = 'open' AND c.sla_breached_at IS NOT NULL)::int AS breached,
        min(c.awaiting_reply_since) FILTER (WHERE c.status = 'open') AS oldest_waiting,
        count(c.id) FILTER (WHERE c.done_at >= date_trunc('day', now()))::int AS done_today
      FROM queues q LEFT JOIN conversations c ON c.queue_id = q.id GROUP BY q.id ORDER BY q.position`);
    const agents = await many(db, `SELECT u.id, u.name, u.email, u.presence, u.role,
        count(c.id) FILTER (WHERE c.status = 'open')::int AS open,
        count(c.id) FILTER (WHERE c.status = 'open' AND c.sla_breached_at IS NOT NULL)::int AS breached,
        (SELECT count(*)::int FROM conversations d WHERE d.owner_id = u.id AND d.done_at >= date_trunc('day', now())) AS done_today
      FROM users u LEFT JOIN conversations c ON c.owner_id = u.id GROUP BY u.id ORDER BY u.presence, u.name`);
    const frt = await one(db, `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_response_at - created_at)/60) AS median_minutes, count(*)::int AS n
      FROM conversations WHERE first_response_at IS NOT NULL AND created_at >= now() - interval '7 days'`);
    res.json({ queues, agents, first_response: frt });
  }));

  // ---------- admin: routing rules ----------

  r.get('/admin/rules', wrap(async (req, res) => {
    const rules = await many(db, 'SELECT * FROM routing_rules ORDER BY position');
    res.json({ rules, warnings: lintRules(rules) });
  }));

  r.put('/admin/rules', needRole('admin'), wrap(async (req, res) => {
    const rules = req.body?.rules;
    if (!Array.isArray(rules)) throw new svc.InboxError(400, 'Send the full ordered list of rules');
    await db.tx(async (q) => {
      await q.query('DELETE FROM routing_rules');
      for (const [i, rule] of rules.entries()) {
        if (!rule.name) throw new svc.InboxError(400, `Rule ${i + 1} needs a name`);
        await q.query('INSERT INTO routing_rules (position, name, enabled, conditions, action, replaces) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)', [(i + 1) * 10, rule.name, rule.enabled !== false, toJson(rule.conditions || {}), toJson(rule.action || {}), rule.replaces || null]);
      }
      await svc.audit(q, req.user.id, 'rules.replaced', 'routing_rules', 'all', { count: rules.length });
    });
    const saved = await many(db, 'SELECT * FROM routing_rules ORDER BY position');
    res.json({ rules: saved, warnings: lintRules(saved) });
  }));

  // Dry run: which rule would this message hit?
  r.post('/admin/rules/test', wrap(async (req, res) => {
    const m = req.body || {};
    const kind = kindForChannel(m.channel || 'email');
    const contacts = await svc.contactsByIdentity(db, kind, normalizeIdentity(kind, m.from));
    const rules = Array.isArray(m.rules) ? m.rules.map((x, i) => ({ ...x, position: i })) : await many(db, 'SELECT * FROM routing_rules');
    const result = route(rules, {
      channel: m.channel,
      to: m.channel === 'email' ? normalizeEmail(m.to) : normalizePhone(m.to),
      from: normalizeIdentity(kind, m.from),
      subject: m.subject,
      body: m.body,
      roles: m.roles || contacts[0]?.roles || [],
      leadStage: m.lead_stage ?? contacts[0]?.lead_stage,
    });
    res.json({ rule: result.rule?.name || null, action: result.action });
  }));

  r.put('/admin/canned/:id?', needRole('admin', 'supervisor'), wrap(async (req, res) => {
    const { shortcut, title, body, channels = [] } = req.body || {};
    if (!shortcut || !title || !body) throw new svc.InboxError(400, 'Shortcut, title and text are required');
    const row = req.params.id
      ? await one(db, 'UPDATE canned_responses SET shortcut = $2, title = $3, body = $4, channels = $5::jsonb WHERE id = $1 RETURNING *', [req.params.id, shortcut, title, body, toJson(channels)])
      : await one(db, 'INSERT INTO canned_responses (shortcut, title, body, channels) VALUES ($1,$2,$3,$4::jsonb) RETURNING *', [shortcut, title, body, toJson(channels)]);
    res.json(row);
  }));

  r.delete('/admin/canned/:id', needRole('admin', 'supervisor'), wrap(async (req, res) => {
    await db.query('DELETE FROM canned_responses WHERE id = $1', [req.params.id]);
    res.status(204).end();
  }));

  r.put('/admin/sla/:id', needRole('admin'), wrap(async (req, res) => {
    const minutes = Number(req.body?.first_response_minutes);
    if (!(minutes > 0)) throw new svc.InboxError(400, 'Minutes must be a positive number');
    res.json(await one(db, 'UPDATE sla_policies SET first_response_minutes = $2, warn_minutes = COALESCE($3, warn_minutes), business_hours = COALESCE($4, business_hours) WHERE id = $1 RETURNING *', [req.params.id, minutes, req.body?.warn_minutes ?? null, req.body?.business_hours ?? null]));
  }));

  r.get('/audit', needRole('supervisor', 'admin'), wrap(async (req, res) => {
    const { object_type, object_id } = req.query;
    res.json(await many(db, `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE ($1::text IS NULL OR a.object_type = $1) AND ($2::text IS NULL OR a.object_id = $2) ORDER BY a.created_at DESC LIMIT 200`, [object_type || null, object_id || null]));
  }));

  // ---------- inbound: simulator (phase 1) and calls ----------

  // Phase 1 stand-in for email/SMS/chat webhooks: lets you test routing, threading,
  // SLAs and the 360 with realistic traffic. Turned off with INBOX_SIMULATOR=false.
  r.post('/simulate/inbound', wrap(async (req, res) => {
    if (config.simulator === false) throw new svc.InboxError(403, 'The simulator is turned off');
    const m = req.body || {};
    const kind = kindForChannel(m.channel);
    const from = normalizeIdentity(kind, m.from);
    const known = from ? await svc.contactsByIdentity(db, kind, from) : [];
    const lookup = !known.length && from ? await l27.identify(req.bearer, kind, from) : null;
    const result = await db.tx((q) => svc.ingestInbound(q, { ...m, external_id: m.external_id || undefined, meta: { simulated: true, by: req.user.email } }, { lookup }));
    res.status(201).json(result);
  }));

  // Call records from the RingCentral widget in the agent's browser.
  r.post('/calls', wrap(async (req, res) => {
    const call = req.body || {};
    const theirs = normalizePhone(call.direction === 'outbound' || call.direction === 'out' ? call.to : call.from);
    if (!theirs) throw new svc.InboxError(400, 'Call needs a phone number');
    const known = await svc.contactsByIdentity(db, 'phone', theirs);
    const lookup = !known.length ? await l27.identify(req.bearer, 'phone', theirs) : null;
    res.status(201).json(await db.tx((q) => svc.logCall(q, req.user, call, { lookup })));
  }));

  // Screen pop: who is calling?
  r.get('/lookup', wrap(async (req, res) => {
    const kind = req.query.kind === 'email' ? 'email' : 'phone';
    const value = normalizeIdentity(kind, req.query.value);
    if (!value) return res.json({ contacts: [], l27: null });
    const contacts = await svc.contactsByIdentity(db, kind, value);
    const open = contacts.length ? await many(db, "SELECT id, channel, subject FROM conversations WHERE contact_id = ANY($1::bigint[]) AND status <> 'done' ORDER BY last_message_at DESC LIMIT 5", [contacts.map((c) => c.id)]) : [];
    res.json({ contacts, open, l27: contacts.length ? null : await l27.identify(req.bearer, kind, value) });
  }));

  r.use((err, req, res, _next) => {
    if (err instanceof svc.InboxError) return res.status(err.status).json({ error: err.message });
    log('error', 'inbox request failed', { path: req.path, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return r;
}
