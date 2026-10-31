// The inbox's core operations. Each takes a query handle `q` ({ query }) so it can run
// inside a transaction. Network calls (Launch27 lookups) happen before the transaction.
import { json } from '../db/index.js';
import { route } from './routing.js';
import { addBusinessMinutes, URBANMOP_HOURS } from './hours.js';
import { normalizeEmail, normalizeIdentity, normalizePhone, kindForChannel, isStopWord, isStartWord } from './normalize.js';
import { sendOutbound } from './channels.js';

const DAY = 24 * 3600_000;
export const REOPEN_WINDOW = { email: 14 * DAY, sms: 2 * DAY, voice: 2 * DAY, chat: 2 * DAY };

const one = async (q, sql, p) => (await q.query(sql, p)).rows[0] || null;
const many = async (q, sql, p) => (await q.query(sql, p)).rows;

export class InboxError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- shared lookups ----------

export async function holidaySet(q) {
  const rows = await many(q, "SELECT to_char(day, 'YYYY-MM-DD') AS day FROM holidays");
  return new Set(rows.map((r) => r.day));
}

async function slaDue(q, policyId, from) {
  if (!policyId) return null;
  const p = await one(q, 'SELECT * FROM sla_policies WHERE id = $1', [policyId]);
  if (!p) return null;
  return addBusinessMinutes(from, p.first_response_minutes, { hours: URBANMOP_HOURS, holidays: await holidaySet(q), businessHours: p.business_hours });
}

export async function audit(q, actorId, action, objectType, objectId, detail = {}) {
  await q.query('INSERT INTO audit_log (actor_id, action, object_type, object_id, detail) VALUES ($1,$2,$3,$4,$5::jsonb)', [actorId ?? null, action, objectType, String(objectId), json(detail)]);
}

export async function notify(q, userId, kind, conversationId, text) {
  if (!userId) return;
  await q.query('INSERT INTO notifications (user_id, kind, conversation_id, text) VALUES ($1,$2,$3,$4)', [userId, kind, conversationId, text]);
}

async function event(q, conversationId, text, meta = {}, authorId = null) {
  return one(q, "INSERT INTO messages (conversation_id, kind, body, meta, author_id) VALUES ($1,'event',$2,$3::jsonb,$4) RETURNING *", [conversationId, text, json(meta), authorId]);
}

async function supervisors(q) {
  return many(q, "SELECT id FROM users WHERE role IN ('supervisor','admin')");
}

// ---------- contacts ----------

export async function contactsByIdentity(q, kind, value) {
  if (!value) return [];
  return many(
    q,
    `SELECT c.* FROM contacts c JOIN contact_identities i ON i.contact_id = c.id
     WHERE i.kind = $1 AND i.value = $2 ORDER BY c.id`,
    [kind, value],
  );
}

export async function createContact(q, { name, roles = [], identities = [], l27_customer_id = null, l27_team_id = null, lead_stage = null, lead_source = null }) {
  const c = await one(
    q,
    `INSERT INTO contacts (name, roles, l27_customer_id, l27_team_id, lead_stage, lead_source)
     VALUES ($1,$2::jsonb,$3,$4,$5,$6) RETURNING *`,
    [name || null, json([...new Set(roles)]), l27_customer_id, l27_team_id, lead_stage, lead_source],
  );
  for (const id of identities) await addIdentity(q, c.id, id.kind, id.value, id.label);
  return c;
}

export async function addIdentity(q, contactId, kind, value, label = null) {
  const v = normalizeIdentity(kind, value);
  if (!v) return null;
  return one(
    q,
    `INSERT INTO contact_identities (contact_id, kind, value, label) VALUES ($1,$2,$3,$4)
     ON CONFLICT (contact_id, kind, value) DO UPDATE SET label = COALESCE(EXCLUDED.label, contact_identities.label)
     RETURNING *`,
    [contactId, kind, v, label],
  );
}

// ---------- assignment ----------

// Push routing: give the conversation to the available queue member with the least open work.
export async function autoAssign(q, conv) {
  if (!conv.queue_id || conv.owner_id || conv.status !== 'open') return conv;
  const pick = await one(
    q,
    `SELECT u.id, u.name, u.email,
            (SELECT count(*) FROM conversations c WHERE c.owner_id = u.id AND c.status = 'open') AS load
     FROM users u JOIN queue_members m ON m.user_id = u.id
     WHERE m.queue_id = $1 AND u.presence = 'available'
     ORDER BY load ASC, u.presence_at ASC NULLS FIRST, u.id ASC LIMIT 1`,
    [conv.queue_id],
  );
  if (!pick) return conv;
  const updated = await one(q, 'UPDATE conversations SET owner_id = $1, updated_at = now() WHERE id = $2 AND owner_id IS NULL RETURNING *', [pick.id, conv.id]);
  if (!updated) return conv;
  await event(q, conv.id, `Assigned to ${pick.name || pick.email} (routing)`, { type: 'assigned', to: pick.id, by: 'routing' });
  await notify(q, pick.id, 'assigned', conv.id, `New ${conv.channel} conversation assigned to you`);
  return updated;
}

// ---------- inbound ----------

// input: { channel, from, to, subject, body, external_id, thread_key, from_name, meta, at }
// lookup: optional result of a Launch27 lookup done before the transaction:
//   { name, roles, l27_customer_id, l27_team_id, identities }
export async function ingestInbound(q, input, { lookup = null, now = new Date() } = {}) {
  const channel = input.channel;
  if (!['email', 'sms', 'voice', 'chat'].includes(channel)) throw new InboxError(400, `Unknown channel: ${channel}`);
  if (input.external_id) {
    const dup = await one(q, 'SELECT conversation_id FROM messages WHERE external_id = $1', [input.external_id]);
    if (dup) return { conversationId: dup.conversation_id, duplicate: true };
  }
  const kind = kindForChannel(channel);
  const from = normalizeIdentity(kind, input.from);
  if (!from) throw new InboxError(400, `Can't read the sender's ${kind}: ${input.from}`);
  const to = (channel === 'email' ? normalizeEmail(input.to) : normalizePhone(input.to)) || input.to || null;
  const at = input.at ? new Date(input.at) : now;

  // 1. Who is it?
  let contacts = await contactsByIdentity(q, kind, from);
  let contact = contacts.length === 1 ? contacts[0] : null;
  const needsMatch = contacts.length > 1;
  if (!contacts.length) {
    contact = await createContact(q, {
      name: lookup?.name || input.from_name || null,
      roles: lookup?.roles || [],
      l27_customer_id: lookup?.l27_customer_id ?? null,
      l27_team_id: lookup?.l27_team_id ?? null,
      identities: [{ kind, value: from }, ...(lookup?.identities || [])],
    });
  }

  // 2. Which conversation?
  let conv = await findThread(q, { channel, from, to, contactId: contact?.id, threadKey: input.thread_key });
  let isNew = false;
  let reopened = false;
  if (conv && conv.status === 'done') {
    const age = at - new Date(conv.done_at || conv.updated_at);
    if (age > (REOPEN_WINDOW[channel] ?? DAY)) conv = null;
    else reopened = true;
  }

  // 3. SMS consent keywords
  let optChange = null;
  if (channel === 'sms' && isStopWord(input.body)) optChange = 'out';
  if (channel === 'sms' && isStartWord(input.body)) optChange = 'in';

  let action = {};
  let ruleName = null;
  if (!conv) {
    isNew = true;
    const routed = route(await many(q, 'SELECT * FROM routing_rules'), {
      channel,
      to,
      from,
      subject: input.subject,
      body: input.body,
      roles: contact?.roles || [],
      leadStage: contact?.lead_stage,
    });
    action = routed.action;
    ruleName = routed.rule?.name || 'No rule matched';
    const queue = await one(q, 'SELECT id FROM queues WHERE slug = $1', [action.queue || 'fallback']);
    const policy = action.sla ? await one(q, 'SELECT id FROM sla_policies WHERE slug = $1', [action.sla]) : null;
    conv = await one(
      q,
      `INSERT INTO conversations (contact_id, needs_match, channel, our_identity, their_identity, subject, thread_key,
                                  queue_id, priority, sla_policy_id, routed_by, last_message_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
      [contact?.id ?? null, needsMatch, channel, to, from, input.subject || null, input.thread_key || null, queue?.id ?? null, action.priority || 3, policy?.id ?? null, ruleName, at],
    );
    await event(q, conv.id, `Routed to ${action.queue || 'fallback'} by "${ruleName}"`, { type: 'routed', rule: ruleName, action });
    if (needsMatch) await event(q, conv.id, `This ${kind} belongs to ${contacts.length} contacts. Pick the right one.`, { type: 'needs_match', candidates: contacts.map((c) => c.id) });
  } else if (reopened) {
    conv = await one(q, "UPDATE conversations SET status = 'open', done_at = NULL, snooze_until = NULL, reopened_count = reopened_count + 1, updated_at = now() WHERE id = $1 RETURNING *", [conv.id]);
    await event(q, conv.id, 'Reopened by a new message', { type: 'reopened' });
    // The owner keeps it if they're around; otherwise it goes back to the queue.
    if (conv.owner_id) {
      const owner = await one(q, 'SELECT presence FROM users WHERE id = $1', [conv.owner_id]);
      if (owner?.presence !== 'available') conv = await one(q, 'UPDATE conversations SET owner_id = NULL WHERE id = $1 RETURNING *', [conv.id]);
    }
  } else if (conv.status === 'snoozed') {
    conv = await one(q, "UPDATE conversations SET status = 'open', snooze_until = NULL, updated_at = now() WHERE id = $1 RETURNING *", [conv.id]);
    await event(q, conv.id, 'Woken by a customer reply', { type: 'woken' });
  }

  // 4. Store the message
  const body = action.redact ? '[Verification code removed: open the private mailbox]' : input.body || '';
  const msg = await one(
    q,
    `INSERT INTO messages (conversation_id, kind, direction, channel, from_addr, to_addr, subject, body, delivery_state, external_id, meta, created_at)
     VALUES ($1,'message','in',$2,$3,$4,$5,$6,'received',$7,$8::jsonb,$9) RETURNING *`,
    [conv.id, channel, from, to, input.subject || null, body, input.external_id || null, json({ ...(input.meta || {}), from_name: input.from_name || undefined }), at],
  );

  if (optChange && contact) {
    await q.query('UPDATE contact_identities SET opted_out = $1, opted_out_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE kind = $2 AND value = $3', [optChange === 'out', 'phone', from]);
    await event(q, conv.id, optChange === 'out' ? `${from} replied STOP: texts to this number are blocked` : `${from} opted back in to texts`, { type: 'consent', value: optChange });
  }

  // 5. Status, SLA clock and preview
  const awaiting = conv.awaiting_reply_since ? new Date(conv.awaiting_reply_since) : at;
  const due = conv.sla_due_at ? new Date(conv.sla_due_at) : await slaDue(q, conv.sla_policy_id, awaiting);
  const markDone = isNew && (action.mark_done || optChange === 'out');
  conv = await one(
    q,
    `UPDATE conversations SET last_message_at = $2, last_preview = $3, awaiting_reply_since = $4,
            sla_due_at = $5, updated_at = now(),
            status = CASE WHEN $6 THEN 'done' ELSE status END,
            done_at = CASE WHEN $6 THEN now() ELSE done_at END,
            disposition = CASE WHEN $6 THEN $7::jsonb ELSE disposition END
     WHERE id = $1 RETURNING *`,
    [conv.id, at, body.slice(0, 160), markDone ? null : awaiting, markDone ? null : due, markDone, json(action.disposition || (optChange === 'out' ? { audience: 'Customer', reason: 'Other', outcome: 'No action needed', note: 'Opted out of texts' } : null))],
  );

  // 6. Hand it to someone
  if (conv.status === 'open') {
    if (conv.owner_id) await notify(q, conv.owner_id, 'reply', conv.id, `New ${channel} from ${contact?.name || from}`);
    else conv = await autoAssign(q, conv);
  }
  return { conversationId: conv.id, messageId: msg.id, isNew, reopened, contactId: contact?.id ?? null };
}

async function findThread(q, { channel, from, to, contactId, threadKey }) {
  if (channel === 'email' && threadKey) {
    const t = await one(q, "SELECT * FROM conversations WHERE channel = 'email' AND thread_key = $1 ORDER BY id DESC LIMIT 1", [threadKey]);
    if (t) return t;
  }
  if (channel === 'email' || channel === 'chat') return null; // a new email thread is a new conversation
  if (channel === 'sms') {
    return one(
      q,
      `SELECT * FROM conversations WHERE their_identity = $1 AND our_identity IS NOT DISTINCT FROM $2
       AND channel = 'sms' ORDER BY (status <> 'done') DESC, last_message_at DESC LIMIT 1`,
      [from, to],
    );
  }
  // voice: join whatever is open with this person
  if (contactId) {
    const open = await one(q, "SELECT * FROM conversations WHERE contact_id = $1 AND status <> 'done' ORDER BY last_message_at DESC LIMIT 1", [contactId]);
    if (open) return open;
  }
  return one(q, "SELECT * FROM conversations WHERE their_identity = $1 AND channel = 'voice' ORDER BY last_message_at DESC LIMIT 1", [from]);
}

// ---------- calls (RingCentral widget events) ----------

// call: { call_id, direction, from, to, started_at, duration_seconds, result, recording_url, our_number }
export async function logCall(q, user, call, { lookup = null, now = new Date() } = {}) {
  const direction = call.direction === 'outbound' || call.direction === 'out' ? 'out' : 'in';
  const theirs = direction === 'in' ? call.from : call.to;
  const ours = direction === 'in' ? call.to : call.from;
  const missed = direction === 'in' && ['missed', 'voicemail'].includes(call.result);
  const extId = call.call_id ? `rc:${call.call_id}` : null;
  if (extId) {
    const dup = await one(q, 'SELECT conversation_id FROM messages WHERE external_id = $1', [extId]);
    if (dup) return { conversationId: dup.conversation_id, duplicate: true };
  }
  const summary = `${direction === 'in' ? 'Inbound' : 'Outbound'} call, ${call.result || 'answered'}${call.duration_seconds ? `, ${Math.round(call.duration_seconds / 60)} min` : ''}`;
  if (direction === 'in') {
    const res = await ingestInbound(q, { channel: 'voice', from: theirs, to: ours, body: summary, external_id: extId, at: call.started_at, meta: { call } }, { lookup, now });
    await q.query("UPDATE messages SET kind = 'call', meta = meta || $2::jsonb WHERE id = $1", [res.messageId, json({ result: call.result, duration_seconds: call.duration_seconds, recording_url: call.recording_url || null, agent_id: user?.id })]);
    if (!missed && user) {
      // Answered: the agent who took it owns it and the SLA clock stops.
      await q.query("UPDATE conversations SET owner_id = COALESCE(owner_id, $2), awaiting_reply_since = NULL, sla_due_at = NULL, first_response_at = COALESCE(first_response_at, now()) WHERE id = $1", [res.conversationId, user.id]);
    } else if (missed) {
      const voice = await one(q, "SELECT id FROM sla_policies WHERE slug = 'voice'");
      const conv = await one(q, 'SELECT * FROM conversations WHERE id = $1', [res.conversationId]);
      if (voice && !conv.sla_due_at) {
        await q.query('UPDATE conversations SET sla_policy_id = $2, sla_due_at = $3 WHERE id = $1', [conv.id, voice.id, await slaDue(q, voice.id, new Date(call.started_at || now))]);
      }
    }
    return res;
  }
  // Outbound: attach to the person's open conversation, or start a voice conversation owned by the caller.
  const phone = normalizePhone(theirs);
  let contacts = await contactsByIdentity(q, 'phone', phone);
  let contact = contacts[0] || (await createContact(q, { name: lookup?.name, roles: lookup?.roles || [], l27_customer_id: lookup?.l27_customer_id, l27_team_id: lookup?.l27_team_id, identities: [{ kind: 'phone', value: phone }] }));
  let conv = await one(q, "SELECT * FROM conversations WHERE contact_id = $1 AND status <> 'done' ORDER BY last_message_at DESC LIMIT 1", [contact.id]);
  if (!conv) {
    const ops = await one(q, "SELECT id FROM queues WHERE slug = 'operations'");
    conv = await one(q, "INSERT INTO conversations (contact_id, channel, our_identity, their_identity, queue_id, owner_id, routed_by) VALUES ($1,'voice',$2,$3,$4,$5,'Outbound call') RETURNING *", [contact.id, normalizePhone(ours), phone, ops?.id, user?.id ?? null]);
  }
  const msg = await one(
    q,
    `INSERT INTO messages (conversation_id, kind, direction, channel, from_addr, to_addr, body, author_id, external_id, meta, created_at)
     VALUES ($1,'call','out','voice',$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
    [conv.id, normalizePhone(ours), phone, summary, user?.id ?? null, extId, json({ result: call.result, duration_seconds: call.duration_seconds, recording_url: call.recording_url || null }), call.started_at ? new Date(call.started_at) : now],
  );
  if (call.result !== 'no_answer') {
    await q.query('UPDATE conversations SET awaiting_reply_since = NULL, sla_due_at = NULL, first_response_at = COALESCE(first_response_at, now()), last_message_at = now(), last_preview = $2 WHERE id = $1', [conv.id, summary]);
  }
  return { conversationId: conv.id, messageId: msg.id, contactId: contact.id };
}

// ---------- outbound, notes, events ----------

export async function reply(q, user, convId, { body, channel, to, subject, from }, { connectors = {} } = {}) {
  const conv = await one(q, 'SELECT * FROM conversations WHERE id = $1', [convId]);
  if (!conv) throw new InboxError(404, 'Conversation not found');
  if (!body?.trim()) throw new InboxError(400, 'Write a message first');
  const ch = channel || conv.channel;
  if (ch === 'voice') throw new InboxError(400, 'Use the phone to call; replies go by email or text');
  const kind = kindForChannel(ch);
  const target = normalizeIdentity(kind, to || (ch === conv.channel ? conv.their_identity : null));
  if (!target) throw new InboxError(400, `Pick a ${kind === 'email' ? 'email address' : 'phone number'} to send to`);
  if (ch === 'sms') {
    const blocked = await one(q, "SELECT 1 FROM contact_identities WHERE kind = 'phone' AND value = $1 AND opted_out", [target]);
    if (blocked) throw new InboxError(409, `${target} replied STOP. Texts to this number are blocked until they text START.`);
  }
  const fromId = from || (ch === conv.channel ? conv.our_identity : null);
  const result = await sendOutbound({ channel: ch, from: fromId, to: target, subject: subject ?? (conv.subject ? `Re: ${conv.subject.replace(/^re:\s*/i, '')}` : null), body }, connectors);
  const msg = await one(
    q,
    `INSERT INTO messages (conversation_id, kind, direction, channel, from_addr, to_addr, subject, body, author_id, delivery_state, external_id, meta)
     VALUES ($1,'message','out',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
    [convId, ch, fromId, target, subject ?? null, body, user.id, result.state, result.external_id || null, json({ provider: result.provider, note: result.note })],
  );
  await q.query(
    `UPDATE conversations SET first_response_at = COALESCE(first_response_at, now()), awaiting_reply_since = NULL,
            sla_due_at = NULL, sla_warned_at = NULL, last_message_at = now(), last_preview = $2,
            owner_id = COALESCE(owner_id, $3), status = CASE WHEN status = 'snoozed' THEN 'open' ELSE status END, updated_at = now()
     WHERE id = $1`,
    [convId, body.slice(0, 160), user.id],
  );
  await audit(q, user.id, 'message.sent', 'conversation', convId, { message_id: msg.id, channel: ch, to: target, state: result.state });
  return msg;
}

export async function addNote(q, user, convId, body) {
  if (!body?.trim()) throw new InboxError(400, 'Write a note first');
  const msg = await one(q, "INSERT INTO messages (conversation_id, kind, body, author_id) VALUES ($1,'note',$2,$3) RETURNING *", [convId, body, user.id]);
  // @mentions: @jane matches jane@urbanmop.ca or a user named Jane; @operations notifies a queue's members.
  const handles = [...new Set([...body.matchAll(/@([\w.-]+)/g)].map((m) => m[1].toLowerCase()))];
  for (const h of handles) {
    const users = await many(q, `SELECT id FROM users WHERE lower(split_part(email,'@',1)) = $1 OR lower(replace(coalesce(name,''),' ','')) = $1 OR lower(split_part(coalesce(name,''),' ',1)) = $1`, [h]);
    const queueMembers = await many(q, 'SELECT m.user_id AS id FROM queue_members m JOIN queues qu ON qu.id = m.queue_id WHERE qu.slug = $1', [h]);
    for (const u of [...users, ...queueMembers]) if (u.id !== user.id) await notify(q, u.id, 'mention', convId, `${user.name || user.email} mentioned you`);
  }
  await audit(q, user.id, 'note.added', 'conversation', convId, { message_id: msg.id });
  return msg;
}

export async function addEvent(q, user, convId, text, meta = {}) {
  const msg = await event(q, convId, text, meta, user?.id ?? null);
  await audit(q, user?.id, 'event.added', 'conversation', convId, { text, meta });
  return msg;
}

// ---------- status, assignment, presence ----------

const DISPOSITION_FIELDS = ['audience', 'reason', 'outcome'];

export async function updateConversation(q, user, convId, patch) {
  const conv = await one(q, 'SELECT * FROM conversations WHERE id = $1', [convId]);
  if (!conv) throw new InboxError(404, 'Conversation not found');
  const sets = [];
  const params = [convId];
  const set = (col, val, cast = '') => {
    params.push(val);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  const changes = {};

  if (patch.disposition !== undefined) {
    set('disposition', json(patch.disposition), '::jsonb');
    changes.disposition = patch.disposition;
  }
  if (patch.status && patch.status !== conv.status) {
    if (!['open', 'snoozed', 'done'].includes(patch.status)) throw new InboxError(400, 'Status must be open, snoozed or done');
    if (patch.status === 'done') {
      const d = patch.disposition ?? conv.disposition;
      const missing = DISPOSITION_FIELDS.filter((f) => !d?.[f]);
      if (missing.length) throw new InboxError(422, `Pick ${missing.join(', ')} before marking done`);
      sets.push('done_at = now()', 'sla_due_at = NULL', 'awaiting_reply_since = NULL');
    }
    if (patch.status === 'snoozed') {
      const until = new Date(patch.snooze_until || '');
      if (Number.isNaN(until.getTime()) || until <= new Date()) throw new InboxError(400, 'Pick a time in the future to snooze until');
      set('snooze_until', until);
    }
    if (patch.status === 'open') sets.push('snooze_until = NULL', 'done_at = NULL');
    set('status', patch.status);
    changes.status = [conv.status, patch.status];
  }
  if (patch.queue_id !== undefined && patch.queue_id !== conv.queue_id) {
    set('queue_id', patch.queue_id);
    if (!patch.keep_owner) sets.push('owner_id = NULL');
    changes.queue = [conv.queue_id, patch.queue_id];
  }
  for (const key of ['priority', 'l27_booking_id', 'contact_id', 'subject']) {
    if (patch[key] !== undefined && patch[key] !== conv[key]) {
      set(key, patch[key]);
      changes[key] = [conv[key], patch[key]];
    }
  }
  if (patch.contact_id !== undefined) sets.push('needs_match = false');
  if (patch.complaint !== undefined) {
    set('complaint', json(patch.complaint), '::jsonb');
    changes.complaint = patch.complaint;
  }
  if (!sets.length) return conv;
  sets.push('updated_at = now()');
  let updated = await one(q, `UPDATE conversations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  const label = describeChanges(changes);
  if (label) await event(q, convId, `${label} by ${user.name || user.email}`, { type: 'updated', changes }, user.id);
  await audit(q, user.id, 'conversation.updated', 'conversation', convId, changes);
  if (changes.queue && !updated.owner_id) updated = await autoAssign(q, updated);
  return updated;
}

function describeChanges(c) {
  const parts = [];
  if (c.status) parts.push(c.status[1] === 'done' ? `Marked done (${c.disposition?.reason || 'disposition set'})` : c.status[1] === 'snoozed' ? 'Snoozed' : 'Reopened');
  if (c.queue) parts.push('Moved to another queue');
  if (c.priority) parts.push(`Priority set to ${c.priority[1]}`);
  if (c.l27_booking_id) parts.push(c.l27_booking_id[1] ? `Linked to booking #${c.l27_booking_id[1]}` : 'Booking unlinked');
  if (c.contact_id) parts.push('Matched to a contact');
  if (c.complaint) parts.push('Complaint updated');
  return parts.join('; ');
}

export async function claim(q, user, convId) {
  const updated = await one(q, 'UPDATE conversations SET owner_id = $2, updated_at = now() WHERE id = $1 AND owner_id IS NULL RETURNING *', [convId, user.id]);
  if (!updated) {
    const cur = await one(q, 'SELECT c.owner_id, u.name, u.email FROM conversations c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = $1', [convId]);
    if (!cur) throw new InboxError(404, 'Conversation not found');
    if (cur.owner_id === user.id) return one(q, 'SELECT * FROM conversations WHERE id = $1', [convId]);
    throw new InboxError(409, `${cur.name || cur.email} already owns this conversation`);
  }
  await event(q, convId, `Claimed by ${user.name || user.email}`, { type: 'assigned', to: user.id, by: user.id }, user.id);
  await audit(q, user.id, 'conversation.claimed', 'conversation', convId);
  return updated;
}

export async function assign(q, actor, convId, userId, reason = null) {
  const target = userId ? await one(q, 'SELECT * FROM users WHERE id = $1', [userId]) : null;
  if (userId && !target) throw new InboxError(404, 'User not found');
  const before = await one(q, 'SELECT owner_id FROM conversations WHERE id = $1', [convId]);
  if (!before) throw new InboxError(404, 'Conversation not found');
  const updated = await one(q, 'UPDATE conversations SET owner_id = $2, updated_at = now() WHERE id = $1 RETURNING *', [convId, userId || null]);
  const who = target ? target.name || target.email : 'the queue';
  await event(q, convId, `${target ? 'Assigned to' : 'Returned to'} ${who} by ${actor.name || actor.email}${reason ? ` (${reason})` : ''}`, { type: 'assigned', from: before.owner_id, to: userId || null, by: actor.id, reason }, actor.id);
  if (target && target.id !== actor.id) await notify(q, target.id, 'assigned', convId, `${actor.name || actor.email} assigned you a conversation`);
  await audit(q, actor.id, 'conversation.assigned', 'conversation', convId, { from: before.owner_id, to: userId || null, reason });
  return target ? updated : autoAssign(q, updated);
}

export async function setPresence(q, user, presence) {
  if (!['available', 'busy', 'offline'].includes(presence)) throw new InboxError(400, 'Presence must be available, busy or offline');
  await q.query('UPDATE users SET presence = $2, presence_at = now() WHERE id = $1', [user.id, presence]);
  let requeued = 0;
  if (presence === 'offline') {
    // Same as Kustomer today: going offline hands open and snoozed work back to the queues.
    const mine = await many(q, "UPDATE conversations SET owner_id = NULL, updated_at = now() WHERE owner_id = $1 AND status IN ('open','snoozed') RETURNING *", [user.id]);
    for (const c of mine) {
      await event(q, c.id, `Returned to the queue: ${user.name || user.email} went offline`, { type: 'assigned', from: user.id, to: null, by: 'presence' });
      await autoAssign(q, c);
    }
    requeued = mine.length;
  }
  if (presence === 'available') {
    // Pick up waiting work in my queues.
    const waiting = await many(q, "SELECT c.* FROM conversations c JOIN queue_members m ON m.queue_id = c.queue_id WHERE m.user_id = $1 AND c.owner_id IS NULL AND c.status = 'open' ORDER BY c.priority DESC, c.sla_due_at ASC NULLS LAST, c.created_at ASC LIMIT 50", [user.id]);
    for (const c of waiting) await autoAssign(q, c);
  }
  await audit(q, user.id, 'presence.changed', 'user', user.id, { presence });
  return { presence, requeued };
}

// ---------- background tick: snoozes and SLA alarms ----------

export async function tick(q, now = new Date()) {
  const woke = await many(q, "UPDATE conversations SET status = 'open', snooze_until = NULL, updated_at = now() WHERE status = 'snoozed' AND snooze_until <= $1 RETURNING *", [now]);
  for (const c of woke) {
    await event(q, c.id, 'Snooze ended', { type: 'woken' });
    // Time spent snoozed doesn't count against the reply target.
    if (c.awaiting_reply_since && c.sla_policy_id) {
      await q.query('UPDATE conversations SET sla_due_at = $2, sla_breached_at = NULL, sla_warned_at = NULL WHERE id = $1', [c.id, await slaDue(q, c.sla_policy_id, now)]);
    }
    if (c.owner_id) await notify(q, c.owner_id, 'reply', c.id, 'A snoozed conversation is back');
    else await autoAssign(q, c);
  }

  const warn = await many(
    q,
    `UPDATE conversations c SET sla_warned_at = $1 FROM sla_policies p
     WHERE p.id = c.sla_policy_id AND c.status = 'open' AND c.sla_due_at IS NOT NULL AND c.sla_warned_at IS NULL
       AND c.sla_breached_at IS NULL AND c.sla_due_at - make_interval(mins => p.warn_minutes) <= $1 AND c.sla_due_at > $1
     RETURNING c.*`,
    [now],
  );
  for (const c of warn) {
    const targets = c.owner_id ? [{ id: c.owner_id }] : await many(q, 'SELECT user_id AS id FROM queue_members WHERE queue_id = $1', [c.queue_id]);
    for (const t of targets) await notify(q, t.id, 'sla_warning', c.id, `Reply due ${c.owner_id ? '' : 'in your queue '}soon`);
  }

  const breached = await many(q, "UPDATE conversations SET sla_breached_at = $1 WHERE status = 'open' AND sla_due_at <= $1 AND sla_breached_at IS NULL RETURNING *", [now]);
  for (const c of breached) {
    await event(q, c.id, 'Reply target missed', { type: 'sla_breach' });
    const targets = new Set([c.owner_id, ...(await supervisors(q)).map((s) => s.id)].filter(Boolean));
    for (const id of targets) await notify(q, id, 'sla_breach', c.id, 'A reply target was missed');
  }
  return { woke: woke.length, warned: warn.length, breached: breached.length };
}
