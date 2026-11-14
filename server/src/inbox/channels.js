// Channel connectors. Each channel that can send has one:
//
//   connectors.email = { name: 'gmail',  identities: [...], send: async ({ from, to, subject, body, thread }) => ({ id, thread_key, message_id }) }
//   connectors.sms   = { name: 'twilio', send: async ({ from, to, body }) => ({ id }) }
//
// Email is Gmail (server/src/inbox/email/), connected in production when GMAIL_* is set; its
// inbound side is the mailbox sync in email/sync.js, which calls ingestInbound() with the
// message's Message-ID as external_id, so mail read twice is stored once. SMS is not
// connected yet: replies are saved and shown as "not sent", and inbound texts come from the
// simulator (POST /api/simulate/inbound).

// EMAIL IS READ-ONLY. Email can be read (the Gmail sync brings customers' mail into the inbox)
// but nothing can be sent to anyone from this platform, in any environment. This is a code
// constant on purpose: turning sending on needs an approved code change, not a setting.
// Also enforced in service.js (replies refused), api.js (no new email conversations) and
// gmail.js (only Gmail's read-only permission is requested, so Google would refuse a send).
export const EMAIL_SENDING_ENABLED = false;
export const EMAIL_READ_ONLY_MESSAGE = "Email is read-only: emails can't be sent from this platform. Reply by text, or add an internal note.";

// Outside production, connectors are wrapped so nothing reaches a real customer: the
// message is recorded with delivery state "sandbox". See guardConnectors().
export async function sendOutbound(message, connectors = {}) {
  // Backstop: even if a caller gets here, an email is never handed to a connector.
  if (message.channel === 'email' && !EMAIL_SENDING_ENABLED) {
    return { state: 'not_sent', provider: null, note: EMAIL_READ_ONLY_MESSAGE };
  }
  const connector = connectors[message.channel];
  if (connector?.sandbox) {
    return { state: 'sandbox', provider: connector.name, note: 'Sandbox environment: recorded, not sent to the customer.' };
  }
  if (!connector) {
    return { state: 'not_connected', provider: null, note: `${message.channel.toUpperCase()} isn't connected yet, so this was saved but not sent.` };
  }
  try {
    const res = await connector.send(message);
    return { state: 'sent', provider: connector.name, external_id: res?.id ? `${connector.name}:${res.id}` : null, thread_key: res?.thread_key || null, message_id: res?.message_id || null };
  } catch (err) {
    return { state: 'failed', provider: connector.name, note: err.message };
  }
}

export const connectedChannels = (connectors = {}) => Object.keys(connectors);

/** Addresses a channel can actually send from, or null when any of ours will do. */
export const sendableIdentities = (connectors = {}, channel) => connectors[channel]?.identities || null;

/** In any mode other than 'live', replace each connector with a sandbox stand-in that never sends. */
export function guardConnectors(connectors = {}, mode = 'sandbox') {
  const guarded = mode === 'live' ? { ...connectors } : Object.fromEntries(Object.entries(connectors).map(([channel, c]) => [channel, { name: c.name, identities: c.identities, sandbox: true, send: async () => ({ id: null }) }]));
  // Read-only email: whatever the mode, the email connector the app sees cannot send.
  if (guarded.email && !EMAIL_SENDING_ENABLED) {
    const c = guarded.email;
    guarded.email = {
      name: c.name,
      identities: c.identities,
      sandbox: !!c.sandbox,
      readOnly: true,
      send: async () => {
        throw new Error(EMAIL_READ_ONLY_MESSAGE);
      },
    };
  }
  return guarded;
}

/** Dev and QA: email works end to end (compose, thread, route) but every send is a sandbox record. */
export const sandboxEmail = () => ({ name: 'sandbox', send: async () => ({ id: null }) });
