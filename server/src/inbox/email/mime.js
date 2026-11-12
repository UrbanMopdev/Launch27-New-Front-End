// Email formatting with no dependencies: build the plain-text messages we send, and read the
// messages Gmail hands back (headers, the text part, attachment names, quoted history).
import { randomUUID } from 'node:crypto';
import { normalizeEmail } from '../normalize.js';

// Header values never carry line breaks (that's how header injection works).
const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

// RFC 2047: non-ASCII header text as =?UTF-8?B?...?=
export function encodeHeader(value) {
  const v = clean(value);
  // eslint-disable-next-line no-control-regex -- detecting non-ASCII
  return /[^\x00-\x7F]/.test(v) ? `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=` : v;
}

export function decodeHeader(value) {
  return String(value ?? '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_, charset, enc, text) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return text;
    }
  });
}

function formatAddress(address, name) {
  if (!name) return clean(address);
  const n = clean(name);
  // eslint-disable-next-line no-control-regex -- detecting non-ASCII
  const shown = /[^\x00-\x7F]/.test(n) ? encodeHeader(n) : `"${n.replace(/["\\]/g, '\\$&')}"`;
  return `${shown} <${clean(address)}>`;
}

export const newMessageId = (from) => `<${randomUUID()}@${(normalizeEmail(from) || 'localhost').split('@')[1]}>`;

/**
 * An RFC 5322 plain-text message, ready for Gmail's `raw` field (base64url).
 * thread: { inReplyTo, references[] } keeps it in the customer's existing email thread.
 */
export function buildMessage({ from, fromName, to, subject, body, messageId = newMessageId(from), inReplyTo = null, references = [], date = new Date() }) {
  const refs = [...new Set([...(references || []), inReplyTo].filter(Boolean).map(clean))].slice(-20);
  const lines = [
    `From: ${formatAddress(from, fromName)}`,
    `To: ${clean(to)}`,
    `Subject: ${encodeHeader(subject || '(no subject)')}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${clean(messageId)}`,
    inReplyTo && `In-Reply-To: ${clean(inReplyTo)}`,
    refs.length && `References: ${refs.join(' ')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  const encoded = Buffer.from(String(body ?? '').replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const raw = `${lines.join('\r\n')}\r\n\r\n${encoded}\r\n`;
  return { raw, messageId: clean(messageId) };
}

export const toBase64Url = (s) => Buffer.from(s, 'utf8').toString('base64url');

// ---------- reading ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]+class="?gmail_quote[\s\S]*$/i, '') // Gmail's quoted history
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cut the quoted earlier messages a reply carries ("On Mon, Jane wrote:", "> ..."), so the
// timeline shows what the customer actually wrote. The full text stays in the message meta.
export function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const two = `${l} ${(lines[i + 1] || '').trim()}`;
    if (
      /^-{2,}\s*(original message|forwarded message)\s*-{2,}$/i.test(l) ||
      /^_{10,}$/.test(l) ||
      /^on .{6,200} wrote:$/i.test(l) ||
      (/^on .{6,200}$/i.test(l) && /^on .{6,300} wrote:$/i.test(two)) ||
      /^le .{6,200} a écrit\s?:$/i.test(l) ||
      (/^from: /i.test(l) && /^(sent|date|to): /i.test((lines[i + 1] || '').trim()))
    ) {
      cut = i;
      break;
    }
  }
  let kept = lines.slice(0, cut);
  // Trailing "> quoted" lines (bottom-posting keeps them; we only drop a quoted tail).
  while (kept.length && (/^\s*>/.test(kept.at(-1)) || !kept.at(-1).trim())) kept.pop();
  const out = kept.join('\n').trim();
  return out || String(text || '').trim();
}

const header = (headers, name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

/** All addresses in an address-list header ("A <a@x>, b@y"). */
export function addressList(value) {
  if (!value) return [];
  return String(value)
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => normalizeEmail(part))
    .filter(Boolean);
}

function displayName(value) {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(decodeHeader(value || ''));
  return m && m[1].trim() ? m[1].trim() : null;
}

const decodePart = (part) => {
  if (!part?.body?.data) return '';
  const charset = /charset="?([^";\s]+)/i.exec(header(part.headers || [], 'content-type') || '')?.[1] || 'utf-8';
  const bytes = Buffer.from(part.body.data, 'base64url');
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
};

function walk(part, out) {
  if (!part) return out;
  const type = (part.mimeType || '').toLowerCase();
  if (part.filename && (part.body?.attachmentId || part.body?.size)) {
    out.attachments.push({ filename: part.filename, type, size: part.body?.size || 0 });
  } else if (type === 'text/plain' && out.text == null) {
    out.text = decodePart(part);
  } else if (type === 'text/html' && out.html == null) {
    out.html = decodePart(part);
  }
  for (const p of part.parts || []) walk(p, out);
  return out;
}

const ids = (value) => (String(value || '').match(/<[^>]+>/g) || []).map((s) => s.trim());

/** A Gmail API message (format=full) as the fields the inbox stores. */
export function parseGmailMessage(msg) {
  const headers = msg.payload?.headers || [];
  const { text, html, attachments } = walk(msg.payload, { text: null, html: null, attachments: [] });
  const full = (text != null && text.trim() ? text : htmlToText(html || '')) || msg.snippet || '';
  const body = stripQuoted(full);
  const fromRaw = header(headers, 'from');
  return {
    gmailId: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds || [],
    messageId: ids(header(headers, 'message-id'))[0] || null,
    inReplyTo: ids(header(headers, 'in-reply-to'))[0] || null,
    references: ids(header(headers, 'references')),
    from: normalizeEmail(fromRaw),
    fromName: displayName(fromRaw),
    to: addressList(header(headers, 'to')),
    cc: addressList(header(headers, 'cc')),
    deliveredTo: addressList([header(headers, 'delivered-to'), header(headers, 'x-original-to')].filter(Boolean).join(',')),
    replyTo: normalizeEmail(header(headers, 'reply-to')),
    subject: decodeHeader(header(headers, 'subject') || '').trim() || null,
    date: msg.internalDate ? new Date(Number(msg.internalDate)) : header(headers, 'date') ? new Date(header(headers, 'date')) : null,
    autoSubmitted: /auto-(generated|replied)/i.test(header(headers, 'auto-submitted') || '') || /bulk|junk|list/i.test(header(headers, 'precedence') || ''),
    body,
    fullBody: full.trim() !== body ? full.trim().slice(0, 20_000) : null,
    attachments,
  };
}
