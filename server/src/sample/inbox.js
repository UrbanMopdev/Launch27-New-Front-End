// Sample support-inbox traffic for dev/QA, so the Inbox, 360 and Supervisor pages have
// something to show. Every sender is one of the synthetic Launch27 customers or cleaners
// (example.com emails, 555 numbers), so the 360 panels link up with synthetic bookings.
// Runs only when SAMPLE_DATA=true, never in production, and only on an empty inbox.

import { createL27Client } from '../inbox/lookup.js';
import { kindForChannel, normalizeIdentity } from '../inbox/normalize.js';
import * as svc from '../inbox/service.js';
import { UM } from '../inbox/seed.js';

const cust = (n) => ({ email: `customer${n}@example.com`, phone: `(613) 555-01${String((n - 1) % 100).padStart(2, '0')}` });
const cleaner = (n) => ({ phone: `(613) 555-02${String(n - 1).padStart(2, '0')}` });

// minutesAgo spreads messages over the last day so some are fresh and some are past
// their reply target. Messages from the same sender thread into one conversation.
export const SAMPLE_MESSAGES = [
  { minutesAgo: 6, channel: 'sms', from: cust(3).phone, to: UM.smsOttawa, body: 'Hi! Is my cleaner still coming today? It is past the arrival window.' },
  { minutesAgo: 14, channel: 'email', from: cust(7).email, to: UM.info, subject: 'Reschedule next week', body: 'Hello, could we move next Tuesday\'s clean to Thursday morning? Thanks!' },
  { minutesAgo: 22, channel: 'sms', from: cleaner(2).phone, to: UM.smsOttawa, body: 'Running 15 min late to my 1pm, traffic on the 417.' },
  { minutesAgo: 35, channel: 'email', from: cust(12).email, to: UM.billing, subject: 'Charged twice?', body: 'I see two charges on my card for the last clean. Can you check and refund one please?' },
  { minutesAgo: 48, channel: 'email', from: cust(18).email, to: UM.customerSuccess, subject: 'Not happy with today', body: 'The kitchen floor was not done and the bathroom mirror still has streaks. Disappointed, we have been customers for two years.' },
  { minutesAgo: 61, channel: 'sms', from: cust(21).phone, to: UM.smsOttawa, body: 'Can I add inside the fridge to tomorrow\'s booking?' },
  { minutesAgo: 75, channel: 'email', from: 'new.lead@example.com', from_name: 'Sam Prospect', to: UM.info, subject: 'Quote for a 3 bedroom', body: 'Hi, looking for a bi-weekly clean for a 3 bed, 2 bath house in Kanata. What would it cost?' },
  { minutesAgo: 90, channel: 'sms', from: cleaner(5).phone, to: UM.smsOttawa, body: 'Customer not home and lockbox code is not working. What should I do?' },
  { minutesAgo: 130, channel: 'email', from: cust(25).email, to: UM.info, subject: 'Pause cleanings', body: 'We are travelling for the month of December, please pause our recurring cleans until January.' },
  { minutesAgo: 180, channel: 'email', from: cust(30).email, to: UM.management, subject: 'Cancel service', body: 'Please cancel our recurring service effective immediately.' },
  { minutesAgo: 240, channel: 'sms', from: cust(3).phone, to: UM.smsOttawa, body: 'Also can they bring extra garbage bags this time' },
  { minutesAgo: 300, channel: 'email', from: 'applicant@example.com', from_name: 'Pat Applicant', to: UM.careers, subject: 'Cleaner position', body: 'Hello, I would like to apply for a cleaning position. I have 3 years of experience.' },
  { minutesAgo: 420, channel: 'email', from: cust(41).email, to: UM.customerSuccess, subject: 'Thank you!', body: 'Just wanted to say the team did an amazing job yesterday. Please pass on our thanks.' },
  { minutesAgo: 720, channel: 'sms', from: cust(44).phone, to: UM.smsOttawa, body: 'What time is my clean on Friday?' },
  { minutesAgo: 1300, channel: 'email', from: cust(52).email, to: UM.billing, subject: 'Receipt for October', body: 'Could you send me receipts for all my October cleans for my expense report?' },
];

export async function loadSampleInbox(db, { fetchImpl, baseUrl, bearer = 'mock-bearer', log = () => {}, now = new Date(), messages = SAMPLE_MESSAGES } = {}) {
  const existing = await db.query('SELECT count(*)::int AS n FROM conversations');
  if (existing.rows[0].n > 0) return { loaded: 0, skipped: 'inbox not empty' };
  const l27 = createL27Client({ baseUrl, fetchImpl });
  let loaded = 0;
  // Oldest first, so threads build up in order.
  for (const [i, m] of [...messages].sort((a, b) => b.minutesAgo - a.minutesAgo).entries()) {
    const kind = kindForChannel(m.channel);
    const from = normalizeIdentity(kind, m.from);
    const known = await svc.contactsByIdentity(db, kind, from);
    const lookup = known.length ? null : await l27.identify(bearer, kind, from);
    const at = new Date(now.getTime() - m.minutesAgo * 60_000);
    await db.tx((q) => svc.ingestInbound(q, { ...m, minutesAgo: undefined, at, external_id: `sample-${i}`, meta: { sample: true } }, { lookup, now: at }));
    loaded++;
  }
  log('info', 'loaded sample inbox', { messages: loaded });
  return { loaded };
}
