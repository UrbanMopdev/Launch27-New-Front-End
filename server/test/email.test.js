// The email channel: MIME in and out, the Gmail connector, the mailbox sync, and a full
// customer email conversation through the API against a fake Gmail.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { seed, UM, OUR_IDENTITIES } from '../src/inbox/seed.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildMessage, parseGmailMessage, stripQuoted, htmlToText, decodeHeader } from '../src/inbox/email/mime.js';
import { createGmailClient, createGmailConnector, parseMailboxes, parseServiceAccount } from '../src/inbox/email/gmail.js';
import { createEmailSync } from '../src/inbox/email/sync.js';
import { createL27Client } from '../src/inbox/lookup.js';
import { guardConnectors } from '../src/inbox/channels.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unraw = (raw) => Buffer.from(raw, 'base64url').toString('utf8');
const bodyOf = (raw) => Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');

/** A Gmail message as the API returns it (format=full). */
function gmailMsg({ id, threadId, from, to, subject, text, html, messageId, inReplyTo, references, cc, at = Date.now(), labels = ['INBOX', 'UNREAD'] }) {
  const headers = [
    { name: 'From', value: from },
    { name: 'To', value: to },
    cc && { name: 'Cc', value: cc },
    { name: 'Subject', value: subject },
    { name: 'Message-ID', value: messageId },
    inReplyTo && { name: 'In-Reply-To', value: inReplyTo },
    references && { name: 'References', value: references },
  ].filter(Boolean);
  const parts = [text != null && { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: b64(text), size: text.length } }, html != null && { mimeType: 'text/html', headers: [], body: { data: b64(html), size: html.length } }].filter(Boolean);
  return { id, threadId, labelIds: labels, internalDate: String(at), snippet: (text || '').slice(0, 50), payload: { mimeType: 'multipart/alternative', headers, parts } };
}

/** In-memory Gmail: token endpoint, history, messages, send. */
function fakeGmail() {
  const boxes = new Map(); // account -> { historyId, messages: Map, history: [{id, msgId}] }
  const sent = [];
  let tokenCalls = 0;
  const box = (a) => {
    if (!boxes.has(a)) boxes.set(a, { historyId: 100, messages: new Map(), history: [] });
    return boxes.get(a);
  };
  const deliver = (account, msg) => {
    const b = box(account);
    b.historyId += 1;
    b.messages.set(msg.id, msg);
    b.history.push({ id: b.historyId, msgId: msg.id });
  };
  const fetchImpl = async (url, init = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenCalls += 1;
      const p = new URLSearchParams(init.body);
      assert.ok(p.get('assertion') || p.get('refresh_token'));
      return Response.json({ access_token: `tok${tokenCalls}`, expires_in: 3600 });
    }
    const m = /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/([^/]+)(\/[^?]*)(?:\?(.*))?$/.exec(url);
    assert.ok(m, `unexpected url ${url}`);
    assert.match(init.headers.authorization, /^Bearer tok/);
    const account = decodeURIComponent(m[1]);
    const path = m[2];
    const qs = new URLSearchParams(m[3] || '');
    const b = box(account);
    if (path === '/profile') return Response.json({ emailAddress: account, historyId: String(b.historyId) });
    if (path === '/history') {
      const start = Number(qs.get('startHistoryId'));
      if (start < 50) return Response.json({ error: { code: 404, message: 'Requested entity was not found.' } }, { status: 404 });
      const added = b.history.filter((h) => h.id > start);
      return Response.json({ history: added.map((h) => ({ id: String(h.id), messagesAdded: [{ message: { id: h.msgId } }] })), historyId: String(b.historyId) });
    }
    if (path === '/messages' && init.method !== 'POST') return Response.json({ messages: [...b.messages.keys()].map((id) => ({ id })) });
    if (path === '/messages/send') {
      const body = JSON.parse(init.body);
      const raw = unraw(body.raw);
      const id = `sent${sent.length + 1}`;
      const threadId = body.threadId || `t-${id}`;
      const messageId = /^Message-ID: (.+)$/m.exec(raw)[1].trim();
      sent.push({ account, raw, threadId: body.threadId || null, id, messageId });
      b.messages.set(id, { id, threadId, labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: messageId }] } });
      return Response.json({ id, threadId, labelIds: ['SENT'] });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    if (one) {
      const msg = b.messages.get(decodeURIComponent(one[1]));
      return msg ? Response.json(msg) : Response.json({ error: { code: 404, message: 'Not found' } }, { status: 404 });
    }
    throw new Error(`unhandled ${path}`);
  };
  return { fetchImpl, deliver, sent, box, tokens: () => tokenCalls };
}

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SA = { client_email: 'inbox@urbanmop-support.iam.gserviceaccount.com', private_key: privateKey };

describe('email MIME', () => {
  test('builds a threaded plain-text reply and refuses header injection', () => {
    const { raw, messageId } = buildMessage({ from: UM.info, fromName: 'UrbanMop', to: 'jane@example.com', subject: 'Re: Café visit\r\nBcc: evil@example.com', body: 'Hi Jane,\nSee you Thursday.', inReplyTo: '<a@mail.example.com>', references: ['<root@mail.example.com>'] });
    const head = raw.split('\r\n\r\n')[0];
    assert.match(head, /^From: "UrbanMop" <info@urbanmop\.ca>$/m);
    assert.match(head, /^To: jane@example\.com$/m);
    assert.doesNotMatch(head, /^Bcc:/m);
    assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
    assert.equal(decodeHeader(/^Subject: (.+)$/m.exec(head)[1]), 'Re: Café visit Bcc: evil@example.com');
    assert.match(head, /^In-Reply-To: <a@mail\.example\.com>$/m);
    assert.match(head, /^References: <root@mail\.example\.com> <a@mail\.example\.com>$/m);
    assert.match(messageId, /^<[0-9a-f-]+@urbanmop\.ca>$/);
    assert.equal(bodyOf(raw), 'Hi Jane,\r\nSee you Thursday.');
  });

  test('reads a Gmail message: text part, names, quoted history cut', () => {
    const msg = gmailMsg({ id: 'g1', threadId: 't1', from: '"Jane Doe" <Jane@Example.com>', to: 'UrbanMop <billing@urbanmop.ca>', cc: 'bob@example.com', subject: '=?UTF-8?B?UmVzY2hlZHVsZSDinJM=?=', messageId: '<m1@example.com>', references: '<x@urbanmop.ca> <y@urbanmop.ca>', text: 'Thursday works.\n\nOn Mon, Nov 9, 2026 at 9:00 AM UrbanMop <info@urbanmop.ca> wrote:\n> Can we move it?\n' });
    const p = parseGmailMessage(msg);
    assert.equal(p.from, 'jane@example.com');
    assert.equal(p.fromName, 'Jane Doe');
    assert.deepEqual(p.to, ['billing@urbanmop.ca']);
    assert.deepEqual(p.cc, ['bob@example.com']);
    assert.equal(p.subject, 'Reschedule ✓');
    assert.equal(p.body, 'Thursday works.');
    assert.match(p.fullBody, /Can we move it/);
    assert.deepEqual(p.references, ['<x@urbanmop.ca>', '<y@urbanmop.ca>']);
  });

  test('HTML-only mail becomes readable text', () => {
    assert.equal(htmlToText('<html><head><style>p{}</style></head><body><p>Hi&nbsp;there &amp; thanks</p><div>Line 2<br>Line 3</div><div class="gmail_quote">old stuff</div></body></html>'), 'Hi there & thanks\nLine 2\nLine 3');
    assert.equal(stripQuoted('Yes please\n-----Original Message-----\nFrom: x'), 'Yes please');
    assert.equal(stripQuoted('> only quoted'), '> only quoted'); // never empties a message
  });
});

describe('email config', () => {
  test('mailboxes and send-as aliases', () => {
    const m = parseMailboxes('info@urbanmop.ca, Billing@UrbanMop.ca customersuccess@urbanmop.ca=info@urbanmop.ca');
    assert.deepEqual(m.accounts, ['info@urbanmop.ca', 'billing@urbanmop.ca']);
    assert.equal(m.sendAs.get('customersuccess@urbanmop.ca'), 'info@urbanmop.ca');
    assert.ok(parseServiceAccount(Buffer.from(JSON.stringify(SA)).toString('base64')));
    assert.equal(parseServiceAccount('{"nope":1}'), null);
  });

  test('Gmail connects only in production; dev and QA ignore it', () => {
    const env = { GMAIL_SERVICE_ACCOUNT_JSON: JSON.stringify(SA), GMAIL_MAILBOXES: 'info@urbanmop.ca' };
    const dev = loadConfig({ ...env, APP_ENV: 'development' });
    assert.equal(dev.gmail, null);
    assert.ok(dev.warnings.some((w) => /Gmail settings ignored/.test(w)));
    const prod = loadConfig({ ...env, APP_ENV: 'production' });
    assert.deepEqual(prod.gmail.mailboxes.accounts, ['info@urbanmop.ca']);
    assert.equal(prod.gmail.fromName, 'UrbanMop');
    assert.equal(loadConfig({ APP_ENV: 'production', GMAIL_SERVICE_ACCOUNT_JSON: JSON.stringify(SA) }).gmail, null); // no mailboxes
    assert.ok(loadConfig({ APP_ENV: 'production' }).warnings.some((w) => /Email is not connected/.test(w)));
  });

  test('the connector refuses addresses it cannot send from', async () => {
    const g = fakeGmail();
    const c = createGmailConnector({ client: createGmailClient({ auth: { serviceAccount: SA }, fetchImpl: g.fetchImpl }), mailboxes: parseMailboxes('info@urbanmop.ca') });
    await assert.rejects(c.send({ from: UM.payroll, to: 'a@example.com', subject: 's', body: 'b' }), /isn't connected to Gmail/);
    assert.equal(g.sent.length, 0);
  });
});

describe('customer email conversations end to end (fake Gmail)', () => {
  let db;
  let server;
  let base;
  let cookie;
  let gmail;
  let sync;
  const config = { l27BaseUrl: 'https://l27.invalid', sessionSecret: 's', allowWrites: false, production: true, notificationsMode: 'live', adminEmails: 'boss@urbanmop.ca' };
  const l27Fetch = async (url) => {
    if (url.endsWith('/latest/login')) return Response.json({ bearer: 'tok' });
    if (url.includes('/v1/staff/teams')) return Response.json([]);
    if (url.includes('/v1/staff/customers/77/phones')) return Response.json([]);
    if (url.includes('/v1/staff/customers/77')) return Response.json({ id: 77, first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '613-555-0122' });
    if (url.includes('/v1/staff/customers/88/phones')) return Response.json([]);
    if (url.includes('/v1/staff/customers/88')) return Response.json({ id: 88, first_name: 'Raj', last_name: 'P', email: 'raj@example.com', phone: '613-555-0188' });
    if (url.includes('/v1/staff/customers')) return Response.json(url.includes('jane%40example.com') ? [{ id: 77, first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '613-555-0122' }] : []);
    return Response.json([]);
  };
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };

  before(async () => {
    db = await openDb();
    await seed(db);
    gmail = fakeGmail();
    const mailboxes = parseMailboxes('info@urbanmop.ca,billing@urbanmop.ca,customersuccess@urbanmop.ca=info@urbanmop.ca');
    const client = createGmailClient({ auth: { serviceAccount: SA }, fetchImpl: gmail.fetchImpl });
    const connectors = { email: createGmailConnector({ client, mailboxes, fromName: 'UrbanMop' }) };
    const l27 = createL27Client({ baseUrl: config.l27BaseUrl, fetchImpl: l27Fetch });
    sync = createEmailSync({ db, client, mailboxes, ourIdentities: OUR_IDENTITIES.email, identify: (email) => l27.identify('tok', 'email', email), intervalMs: 0 });
    server = createApp(config, { fetchImpl: l27Fetch, db, connectors }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'boss@urbanmop.ca', password: 'x' }) });
    cookie = res.headers.get('set-cookie').split(';')[0];
  });
  after(async () => {
    server.close();
    await db.close();
  });

  test('first check starts the mailbox from now (plus the last day)', async () => {
    assert.equal(await sync.run(), 0);
    const rows = (await db.query("SELECT address, cursor, last_error FROM channel_accounts WHERE channel = 'email' ORDER BY address")).rows;
    assert.deepEqual(rows.map((r) => r.address), ['billing@urbanmop.ca', 'info@urbanmop.ca']);
    assert.ok(rows.every((r) => r.cursor && !r.last_error));
    const ch = await api('/api/channels');
    assert.equal(ch.body.email.state, 'live');
    assert.equal(ch.body.email.provider, 'gmail');
    const meta = await api('/api/meta');
    assert.deepEqual(meta.body.identities.email.sort(), ['billing@urbanmop.ca', 'customersuccess@urbanmop.ca', 'info@urbanmop.ca']);
  });

  let convId;
  test("a customer's email lands in the inbox, linked to their Launch27 customer", async () => {
    await api('/api/me/presence', { presence: 'available' }, 'PUT');
    gmail.deliver('info@urbanmop.ca', gmailMsg({ id: 'in1', threadId: 'T1', from: 'Jane Doe <jane@example.com>', to: 'info@urbanmop.ca', subject: 'Reschedule next week', messageId: '<cust-1@example.com>', text: 'Could we move Tuesday to Thursday?' }));
    assert.equal(await sync.run(), 1);
    assert.equal(await sync.run(), 0); // read once
    const list = await api('/api/conversations?view=all&channel=email');
    const conv = list.body.find((c) => c.subject === 'Reschedule next week');
    assert.ok(conv, 'in the inbox');
    convId = conv.id;
    const detail = await api(`/api/conversations/${convId}`);
    assert.equal(detail.body.contact.l27_customer_id, 77);
    assert.equal(detail.body.contact.name, 'Jane Doe');
    const msg = detail.body.messages.find((m) => m.kind === 'message');
    assert.equal(msg.body, 'Could we move Tuesday to Thursday?');
    assert.equal(msg.from_addr, 'jane@example.com');
    // The customer page (contact for Launch27 customer 77) lists it under conversations.
    const contact = await api('/api/contacts/from-l27', { customer_id: 77 });
    const full = await api(`/api/contacts/${contact.body.id}`);
    assert.ok(full.body.conversations.some((c) => c.id === convId && c.channel === 'email'));
  });

  test('the agent replies by email: sent through Gmail, in the same thread', async () => {
    const sent = await api(`/api/conversations/${convId}/messages`, { body: 'Thursday 9am works. See you then!' });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.delivery_state, 'sent');
    assert.equal(sent.body.subject, 'Re: Reschedule next week');
    const out = gmail.sent.at(-1);
    assert.equal(out.account, 'info@urbanmop.ca');
    assert.equal(out.threadId, 'T1');
    assert.match(out.raw, /^To: jane@example\.com$/m);
    assert.match(out.raw, /^In-Reply-To: <cust-1@example\.com>$/m);
    assert.equal(bodyOf(out.raw), 'Thursday 9am works. See you then!');
    const stored = (await db.query('SELECT meta, external_id FROM messages WHERE id = $1', [sent.body.id])).rows[0];
    assert.equal(stored.meta.message_id, out.messageId);
    assert.equal(stored.external_id, `gmail:${out.id}`);
  });

  test('their reply joins the conversation, even in another mailbox, by References', async () => {
    const ours = gmail.sent.at(-1).messageId;
    gmail.deliver('billing@urbanmop.ca', gmailMsg({ id: 'in2', threadId: 'OTHER', from: 'jane@example.com', to: 'billing@urbanmop.ca', subject: 'Re: Reschedule next week', messageId: '<cust-2@example.com>', inReplyTo: ours, references: `<cust-1@example.com> ${ours}`, text: 'Perfect, thanks!\n\nOn Tue, UrbanMop wrote:\n> Thursday 9am works.' }));
    assert.equal(await sync.run(), 1);
    const detail = await api(`/api/conversations/${convId}`);
    const msgs = detail.body.messages.filter((m) => m.kind === 'message');
    assert.deepEqual(msgs.map((m) => m.direction), ['in', 'out', 'in']);
    assert.equal(msgs.at(-1).body, 'Perfect, thanks!');
    const n = (await db.query("SELECT count(*)::int AS n FROM conversations WHERE channel = 'email'")).rows[0].n;
    assert.equal(n, 1);
  });

  test('emailing a customer from their page starts a thread their reply comes back to', async () => {
    const contact = await api('/api/contacts/from-l27', { customer_id: 88 });
    const conv = await api('/api/conversations', { contact_id: contact.body.id, channel: 'email' });
    assert.equal(conv.status, 201);
    assert.equal(conv.body.our_identity, UM.info);
    assert.equal(conv.body.their_identity, 'raj@example.com');
    const sent = await api(`/api/conversations/${conv.body.id}/messages`, { body: 'Hi Raj, a quick question about Friday.', subject: 'Your Friday clean' });
    assert.equal(sent.body.delivery_state, 'sent');
    const out = gmail.sent.at(-1);
    assert.equal(out.threadId, null); // new thread
    assert.match(out.raw, /^Subject: Your Friday clean$/m);
    const row = (await db.query('SELECT subject, thread_key FROM conversations WHERE id = $1', [conv.body.id])).rows[0];
    assert.equal(row.subject, 'Your Friday clean');
    assert.equal(row.thread_key, `gmail:info@urbanmop.ca:t-${out.id}`);
    gmail.deliver('info@urbanmop.ca', gmailMsg({ id: 'in3', threadId: `t-${out.id}`, from: 'raj@example.com', to: 'info@urbanmop.ca', subject: 'Re: Your Friday clean', messageId: '<raj-1@example.com>', text: 'Sure, ask away.' }));
    assert.equal(await sync.run(), 1);
    const detail = await api(`/api/conversations/${conv.body.id}`);
    assert.deepEqual(detail.body.messages.filter((m) => m.kind === 'message').map((m) => m.body), ['Hi Raj, a quick question about Friday.', 'Sure, ask away.']);
    const full = await api(`/api/contacts/${contact.body.id}`);
    assert.equal(full.body.conversations.length, 1);
  });

  test('mail from our own addresses is skipped; mail to billing@ routes to Billing', async () => {
    gmail.deliver('info@urbanmop.ca', gmailMsg({ id: 'self', threadId: 'S', from: 'billing@urbanmop.ca', to: 'info@urbanmop.ca', subject: 'Internal', messageId: '<self@urbanmop.ca>', text: 'fyi' }));
    gmail.deliver('billing@urbanmop.ca', gmailMsg({ id: 'bill', threadId: 'B', from: 'new.person@example.com', to: 'billing@urbanmop.ca', subject: 'Invoice question', messageId: '<bill@example.com>', text: 'Where is my invoice?' }));
    assert.equal(await sync.run(), 1);
    const conv = (await db.query("SELECT c.*, q.slug FROM conversations c JOIN queues q ON q.id = c.queue_id WHERE c.subject = 'Invoice question'")).rows[0];
    assert.equal(conv.slug, 'billing');
    assert.equal(conv.our_identity, 'billing@urbanmop.ca');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM conversations WHERE subject = 'Internal'")).rows[0].n, 0);
  });

  test('an expired Gmail history catches up from recent mail without duplicates', async () => {
    await db.query("UPDATE channel_accounts SET cursor = '1' WHERE address = 'info@urbanmop.ca'");
    assert.equal(await sync.run(), 0);
    const cursor = (await db.query("SELECT cursor FROM channel_accounts WHERE address = 'info@urbanmop.ca'")).rows[0].cursor;
    assert.ok(Number(cursor) > 50);
  });

  test('a Gmail failure is recorded on the mailbox and shown, not thrown', async () => {
    const broken = createEmailSync({ db, client: { profile: async () => ({ historyId: 1 }), list: async () => [], changes: async () => { throw new Error('Gmail 403: Delegation denied'); }, message: async () => ({}) }, mailboxes: parseMailboxes('info@urbanmop.ca'), intervalMs: 0 });
    assert.equal(await broken.run(), 0);
    const ch = await api('/api/channels');
    assert.match(ch.body.email.accounts.find((a) => a.address === 'info@urbanmop.ca').last_error, /Delegation denied/);
  });
});

describe('sandbox email (dev and QA)', () => {
  test('replies are recorded, never sent', async () => {
    const g = fakeGmail();
    const guarded = guardConnectors({ email: createGmailConnector({ client: createGmailClient({ auth: { serviceAccount: SA }, fetchImpl: g.fetchImpl }), mailboxes: parseMailboxes('info@urbanmop.ca') }) }, 'sandbox');
    const res = await guarded.email.send({ from: UM.info, to: 'x@example.com', subject: 's', body: 'b' });
    assert.equal(res.id, null);
    assert.equal(g.sent.length, 0);
    assert.equal(g.tokens(), 0);
  });
});
