// Who is the client behind a message a system sent? Pure.
//
// Launch27 notices, RingCentral voicemail and text notices and Stripe mail arrive from the
// system's own address, so the sender says nothing about the client. The client is named inside
// the message instead: in Reply-To, as an email address or phone number in the subject or the
// text, or as a Launch27 booking number. clientHints() pulls those out, strongest first, so the
// case can be tied to a Launch27 client the same way as one the client sent themselves.
import { normalizeEmail, normalizePhone } from '../inbox/normalize.js';

// Mail these domains send is written by a system, not by the client.
export const SYSTEM_DOMAINS = ['launch27mail.com', 'launch27.com', 'ringcentral.com', 'stripe.com', 'e.read.ai', 'kustomerapp.com'];
const OWN = ['urbanmop.ca', 'urbanmop.com'];

const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';
const under = (domain, list) => list.some((d) => domain === d || domain.endsWith(`.${d}`));
export const isSystemSender = (email) => under(domainOf(email), SYSTEM_DOMAINS);
const usable = (email) => !!email && !under(domainOf(email), SYSTEM_DOMAINS) && !under(domainOf(email), OWN) && !/^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster)@/.test(email);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// North American numbers as people and systems write them: (613) 555-0100, 613-555-0100, +1 613 555 0100.
const PHONE = /(?<![\d.])(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?![\d.])/g;
const BOOKING = /\bbooking\s*(?:id|number|no\.?|#)?\s*[:#]?\s*#?(\d{4,9})\b/gi;

/**
 * { emails, phones, booking_ids } named in a message, each without repeats, in the order
 * found: Reply-To first, then the subject, then the text. Our own and system addresses and
 * `ownPhones` (our own lines, E.164) are left out.
 */
export function clientHints({ replyTo = null, subject = '', body = '' } = {}, { ownPhones = [] } = {}) {
  const text = `${subject || ''}\n${body || ''}`;
  const emails = [];
  const add = (list, v) => {
    if (v && !list.includes(v)) list.push(v);
  };
  if (usable(normalizeEmail(replyTo))) add(emails, normalizeEmail(replyTo));
  for (const m of text.match(EMAIL) || []) {
    const e = normalizeEmail(m.replace(/[.]+$/, ''));
    if (usable(e)) add(emails, e);
  }
  const phones = [];
  for (const m of text.matchAll(PHONE)) {
    const p = normalizePhone(`${m[1]}${m[2]}${m[3]}`);
    if (p && !ownPhones.includes(p)) add(phones, p);
  }
  const bookings = [];
  for (const m of text.matchAll(BOOKING)) add(bookings, Number(m[1]));
  return { emails: emails.slice(0, 5), phones: phones.slice(0, 5), booking_ids: bookings.slice(0, 5) };
}

// Launch27 and read.ai mail that is a notice to us, not a message from a client: a digest of
// ratings (each rating is already its own case from the Launch27 ratings source), a notice
// that staff made or cancelled a booking, a schedule. A client's reply relayed by Launch27
// ("From ... Re: ...") is never a notice.
export const NOTICE_LABEL = {
  ratings_digest: 'Launch27 digest of ratings (each rating is already its own case)',
  booking_notice: 'Launch27 notice: booking made by staff',
  cancellation_notice: 'Launch27 notice: booking cancelled',
  schedule_notice: 'Launch27 notice: upcoming schedule',
  meeting_notes: 'Meeting notes (read.ai), not a client message',
};
export function systemNotice(email, subject) {
  const d = domainOf(email);
  const s = String(subject || '').trim();
  if (under(d, ['read.ai'])) return 'meeting_notes';
  if (!under(d, ['launch27mail.com', 'launch27.com'])) return null;
  if (/^from\b/i.test(s) || /\bre:/i.test(s)) return null;
  if (/\bratings?\b.*\bwith comments\b/i.test(s)) return 'ratings_digest';
  if (/\bnew booking by staff\b/i.test(s)) return 'booking_notice';
  if (/\bbooking cancell?ation\b/i.test(s)) return 'cancellation_notice';
  if (/\bupcoming schedule\b/i.test(s)) return 'schedule_notice';
  return null;
}
