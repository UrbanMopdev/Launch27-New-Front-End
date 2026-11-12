// Gmail (Google Workspace) as the email channel: send replies from our addresses and read
// what customers send to them. Plain REST calls with node's fetch and crypto; no SDK.
//
// Two ways to sign in (see docs/email.md):
//   - a service account with domain-wide delegation: one key reads and sends for every
//     @urbanmop.ca mailbox listed in GMAIL_MAILBOXES (recommended);
//   - an OAuth refresh token for a single mailbox (its send-as aliases can still be listed).
// Scopes: gmail.readonly (read new mail) and gmail.send (send). We never delete, label or
// mark mail as read, so the team can keep using Gmail alongside the inbox.
import { createSign } from 'node:crypto';
import { normalizeEmail } from '../normalize.js';
import { buildMessage, toBase64Url } from './mime.js';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users';
const TIMEOUT_MS = 20_000;

export class GmailError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * "info@x.ca, billing@x.ca, help@x.ca=info@x.ca" ->
 *   accounts: mailboxes we sign in to and read (info, billing)
 *   sendAs:   address -> mailbox that sends it (help is a send-as alias of info)
 */
export function parseMailboxes(value) {
  const accounts = [];
  const sendAs = new Map();
  for (const entry of String(value || '').split(/[,\s]+/).filter(Boolean)) {
    const [addr, via] = entry.split('=');
    const address = normalizeEmail(addr);
    const account = normalizeEmail(via || addr);
    if (!address || !account) continue;
    if (!accounts.includes(account)) accounts.push(account);
    sendAs.set(address, account);
    if (!sendAs.has(account)) sendAs.set(account, account);
  }
  return { accounts, sendAs };
}

/** Parse GMAIL_SERVICE_ACCOUNT_JSON (raw JSON or base64 of it). Returns null when unusable. */
export function parseServiceAccount(value) {
  if (!value) return null;
  const text = String(value).trim();
  for (const candidate of [text, Buffer.from(text, 'base64').toString('utf8')]) {
    try {
      const sa = JSON.parse(candidate);
      if (sa.client_email && sa.private_key) return { client_email: sa.client_email, private_key: sa.private_key.replace(/\\n/g, '\n') };
    } catch {
      // try the next form
    }
  }
  return null;
}

export function createGmailClient({ auth, fetchImpl = fetch, now = () => Date.now() }) {
  const tokens = new Map(); // account -> { token, exp }

  async function tokenRequest(params) {
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new GmailError(res.status, `Google sign-in failed: ${body.error_description || body.error || res.status}`);
    return { token: body.access_token, exp: now() + (Number(body.expires_in) || 3600) * 1000 - 60_000 };
  }

  async function token(account) {
    const key = auth.serviceAccount ? account : '*';
    const cached = tokens.get(key);
    if (cached && cached.exp > now()) return cached.token;
    let fresh;
    if (auth.serviceAccount) {
      const iat = Math.floor(now() / 1000);
      const claims = { iss: auth.serviceAccount.client_email, sub: account, scope: GMAIL_SCOPES.join(' '), aud: TOKEN_URL, iat, exp: iat + 3600 };
      const unsigned = `${toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${toBase64Url(JSON.stringify(claims))}`;
      const signature = createSign('RSA-SHA256').update(unsigned).sign(auth.serviceAccount.private_key).toString('base64url');
      fresh = await tokenRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` });
    } else {
      fresh = await tokenRequest({ grant_type: 'refresh_token', client_id: auth.clientId, client_secret: auth.clientSecret, refresh_token: auth.refreshToken });
    }
    tokens.set(key, fresh);
    return fresh.token;
  }

  async function call(account, method, path, { query, body } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v == null ? [] : [[k, String(v)]]))).toString()}` : '';
    const res = await fetchImpl(`${API}/${encodeURIComponent(account)}${path}${qs}`, {
      method,
      headers: { authorization: `Bearer ${await token(account)}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) tokens.delete(auth.serviceAccount ? account : '*');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GmailError(res.status, `Gmail ${res.status}: ${data.error?.message || res.statusText || 'request failed'}`);
    return data;
  }

  return {
    profile: (account) => call(account, 'GET', '/profile'),
    /** New INBOX message ids since a history id. Throws GmailError 404 when the id is too old. */
    async changes(account, startHistoryId) {
      const ids = [];
      let pageToken;
      let historyId = startHistoryId;
      do {
        const page = await call(account, 'GET', '/history', { query: { startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: 500, pageToken } });
        for (const h of page.history || []) for (const a of h.messagesAdded || []) if (a.message?.id && !ids.includes(a.message.id)) ids.push(a.message.id);
        historyId = page.historyId || historyId;
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < 2000);
      return { ids, historyId };
    },
    async list(account, q, max = 100) {
      const page = await call(account, 'GET', '/messages', { query: { q, maxResults: max, labelIds: 'INBOX' } });
      return (page.messages || []).map((m) => m.id);
    },
    message: (account, id) => call(account, 'GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'full' } }),
    headers: (account, id, names) => call(account, 'GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'metadata', metadataHeaders: names } }),
    send: (account, { raw, threadId }) => call(account, 'POST', '/messages/send', { body: { raw: toBase64Url(raw), ...(threadId ? { threadId } : {}) } }),
  };
}

export const threadKey = (account, threadId) => (threadId ? `gmail:${account}:${threadId}` : null);
const parseThreadKey = (key) => {
  const m = /^gmail:([^:]+):(.+)$/.exec(key || '');
  return m ? { account: m[1], threadId: m[2] } : null;
};

/**
 * The outbound email connector (see channels.js for the shape).
 * message: { from, to, subject, body, thread: { key, inReplyTo, references } }
 * returns: { id, thread_key, message_id }
 */
export function createGmailConnector({ client, mailboxes, fromName = null }) {
  const { sendAs } = mailboxes;
  return {
    name: 'gmail',
    identities: [...sendAs.keys()],
    async send(message) {
      const from = normalizeEmail(message.from);
      const account = from && sendAs.get(from);
      if (!account) throw new Error(`${message.from || 'That address'} isn't connected to Gmail. Send from ${[...sendAs.keys()].join(', ')}.`);
      const thread = message.thread || {};
      const existing = parseThreadKey(thread.key);
      const { raw, messageId } = buildMessage({ from, fromName, to: message.to, subject: message.subject, body: message.body, inReplyTo: thread.inReplyTo, references: thread.references });
      const sent = await client.send(account, { raw, threadId: existing?.account === account ? existing.threadId : null });
      // Gmail can replace our Message-ID; read back the one the customer will reply to.
      let finalId = messageId;
      try {
        const meta = await client.headers(account, sent.id, ['Message-ID']);
        finalId = meta.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value || messageId;
      } catch {
        // keep ours
      }
      return { id: sent.id, thread_key: threadKey(account, sent.threadId), message_id: finalId };
    },
  };
}
