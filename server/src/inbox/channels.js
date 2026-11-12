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

// Outside production, connectors are wrapped so nothing reaches a real customer: the
// message is recorded with delivery state "sandbox". See guardConnectors().
export async function sendOutbound(message, connectors = {}) {
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
  if (mode === 'live') return connectors;
  return Object.fromEntries(Object.entries(connectors).map(([channel, c]) => [channel, { name: c.name, identities: c.identities, sandbox: true, send: async () => ({ id: null }) }]));
}

/** Dev and QA: email works end to end (compose, thread, route) but every send is a sandbox record. */
export const sandboxEmail = () => ({ name: 'sandbox', send: async () => ({ id: null }) });
