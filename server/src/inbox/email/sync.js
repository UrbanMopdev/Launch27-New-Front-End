// Inbound email: every minute, read new INBOX mail from each connected Gmail mailbox and
// hand it to ingestInbound(), the same matching, threading, routing and SLA code the
// simulator uses. Progress is kept per mailbox in channel_accounts (Gmail history id),
// so a restart picks up where it stopped and nothing is read twice (messages are also
// de-duplicated by their Message-ID, so mail sent to two of our addresses lands once).
import { ingestInbound, contactsByIdentity } from '../service.js';
import { parseGmailMessage } from './mime.js';
import { threadKey } from './gmail.js';

const MAX_ATTEMPTS = 3;

/** The UrbanMop address a message was sent to (drives routing: billing@ -> Billing). */
export function ourAddress(parsed, ours, account) {
  for (const a of [...parsed.to, ...parsed.cc, ...parsed.deliveredTo]) if (ours.has(a)) return a;
  return account;
}

/** Mail we should not turn into a conversation. Returns a reason, or null to keep it. */
export function skipReason(parsed, ours) {
  if (!parsed.from) return 'no sender';
  if (ours.has(parsed.from)) return 'sent by us';
  if (parsed.labelIds.some((l) => ['SPAM', 'TRASH', 'DRAFT'].includes(l))) return 'not inbox mail';
  // Bounces (mailer-daemon) and auto-replies are kept: an agent should see that a reply didn't arrive.
  return null;
}

export function createEmailSync({ db, client, mailboxes, identify = async () => null, ourIdentities = [], intervalMs = 60_000, log = () => {} }) {
  const ours = new Set([...mailboxes.sendAs.keys(), ...ourIdentities.map((x) => x.toLowerCase())]);
  const attempts = new Map(); // gmail id -> failures, so one bad message can't block a mailbox
  let running = null;
  let lastStart = 0;

  const row = async (account) => (await db.query("SELECT * FROM channel_accounts WHERE channel = 'email' AND address = $1", [account])).rows[0] || null;
  const save = (account, fields) =>
    db.query(
      `INSERT INTO channel_accounts (channel, address, provider, cursor, last_poll_at, last_ok_at, last_error, ingested_count)
       VALUES ('email', $1, 'gmail', $2, now(), CASE WHEN $3::text IS NULL THEN now() END, $3, $4)
       ON CONFLICT (channel, address) DO UPDATE SET
         cursor = COALESCE(EXCLUDED.cursor, channel_accounts.cursor), last_poll_at = now(),
         last_ok_at = CASE WHEN EXCLUDED.last_error IS NULL THEN now() ELSE channel_accounts.last_ok_at END,
         last_error = EXCLUDED.last_error, ingested_count = channel_accounts.ingested_count + EXCLUDED.ingested_count`,
      [account, fields.cursor ?? null, fields.error ?? null, fields.ingested ?? 0],
    );

  async function ingestOne(account, id) {
    const parsed = parseGmailMessage(await client.message(account, id));
    const why = skipReason(parsed, ours);
    if (why) return false;
    const external_id = parsed.messageId ? `email:${parsed.messageId.toLowerCase()}` : `gmail:${account}:${parsed.gmailId}`;
    const dup = (await db.query('SELECT 1 FROM messages WHERE external_id = $1', [external_id])).rows[0];
    if (dup) return false;
    const sender = parsed.replyTo && !ours.has(parsed.replyTo) ? parsed.replyTo : parsed.from;
    // Who is this in Launch27? Only for people we haven't seen (network call outside the transaction).
    const known = await contactsByIdentity(db, 'email', sender);
    const lookup = known.length ? null : await identify(sender).catch(() => null);
    const res = await db.tx((q) =>
      ingestInbound(
        q,
        {
          channel: 'email',
          from: sender,
          from_name: parsed.fromName,
          to: ourAddress(parsed, ours, account),
          subject: parsed.subject,
          body: parsed.body,
          external_id,
          thread_key: threadKey(account, parsed.threadId),
          references: [...parsed.references, parsed.inReplyTo].filter(Boolean),
          at: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : undefined,
          meta: {
            provider: 'gmail',
            mailbox: account,
            gmail_id: parsed.gmailId,
            message_id: parsed.messageId,
            cc: parsed.cc.length ? parsed.cc : undefined,
            attachments: parsed.attachments.length ? parsed.attachments : undefined,
            full_body: parsed.fullBody || undefined,
            auto_submitted: parsed.autoSubmitted || undefined,
          },
        },
        { lookup },
      ),
    );
    return !res.duplicate;
  }

  async function pollAccount(account) {
    const state = await row(account);
    if (!state?.cursor) {
      // First connection: start from now, plus the last day of inbox mail so nothing sent
      // while we were being set up is missed.
      const profile = await client.profile(account);
      const recent = await client.list(account, 'newer_than:1d', 100);
      let n = 0;
      for (const id of recent.reverse()) n += (await ingestOne(account, id)) ? 1 : 0;
      await save(account, { cursor: String(profile.historyId), ingested: n });
      return n;
    }
    let changes;
    try {
      changes = await client.changes(account, state.cursor);
    } catch (err) {
      if (err.status !== 404) throw err;
      // History too old (mailbox not read for about a week): catch up from a search instead.
      log('warn', 'gmail history expired; catching up from recent mail', { mailbox: account });
      const profile = await client.profile(account);
      changes = { ids: (await client.list(account, 'newer_than:7d', 500)).reverse(), historyId: profile.historyId };
    }
    let n = 0;
    for (const id of changes.ids) {
      try {
        n += (await ingestOne(account, id)) ? 1 : 0;
        attempts.delete(id);
      } catch (err) {
        const tries = (attempts.get(id) || 0) + 1;
        attempts.set(id, tries);
        if (tries < MAX_ATTEMPTS) throw err; // retry the batch next tick; ingest is idempotent
        log('error', 'gave up on an email after repeated failures', { mailbox: account, gmail_id: id, error: err.message });
        attempts.delete(id);
      }
    }
    await save(account, { cursor: String(changes.historyId), ingested: n });
    return n;
  }

  async function run() {
    let total = 0;
    for (const account of mailboxes.accounts) {
      try {
        total += await pollAccount(account);
      } catch (err) {
        log('error', 'email sync failed', { mailbox: account, error: err.message });
        await save(account, { error: err.message.slice(0, 500) }).catch(() => {});
      }
    }
    if (total) log('info', 'email sync', { ingested: total });
    return total;
  }

  return {
    run,
    /** Called from the worker tick; runs at most every intervalMs and never overlaps. */
    maybeRun() {
      if (running || Date.now() - lastStart < intervalMs) return running;
      lastStart = Date.now();
      running = run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
