// Channel connectors. Phase 1 connects none: outbound messages are saved and shown on the
// timeline as "not sent", and inbound messages arrive through the simulator
// (POST /api/simulate/inbound). Phase 2 adds a connector per channel with the same shape:
//
//   connectors.email = { name: 'gmail',  send: async ({ from, to, subject, body }) => ({ id }) }
//   connectors.sms   = { name: 'twilio', send: async ({ from, to, body }) => ({ id }) }
//
// and webhook routes that call ingestInbound() with the provider's message id as
// external_id, so a webhook delivered twice is stored once.

export async function sendOutbound(message, connectors = {}) {
  const connector = connectors[message.channel];
  if (!connector) {
    return { state: 'not_connected', provider: null, note: `${message.channel.toUpperCase()} isn't connected yet, so this was saved but not sent.` };
  }
  try {
    const res = await connector.send(message);
    return { state: 'sent', provider: connector.name, external_id: res?.id ? `${connector.name}:${res.id}` : null };
  } catch (err) {
    return { state: 'failed', provider: connector.name, note: err.message };
  }
}

export const connectedChannels = (connectors = {}) => Object.keys(connectors);
