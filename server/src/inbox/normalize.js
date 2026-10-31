// Identities are matched on normalized values: lower-case email, E.164 phone.

export function normalizeEmail(value) {
  if (!value) return null;
  const match = String(value).match(/<([^>]+)>/); // "Jane Doe <jane@x.ca>"
  const email = (match ? match[1] : String(value)).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// North American numbers by default (UrbanMop is in Canada; Clean Bee later in the US).
export function normalizePhone(value, defaultCountry = '1') {
  if (!value) return null;
  const raw = String(value).trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (raw.startsWith('+')) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.length >= 8 ? `+${digits}` : null;
}

export function normalizeIdentity(kind, value) {
  return kind === 'email' ? normalizeEmail(value) : normalizePhone(value);
}

export function kindForChannel(channel) {
  return channel === 'email' ? 'email' : channel === 'chat' ? 'email' : 'phone';
}

export function formatPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
}

// Words that stop or restart SMS under CASL / carrier rules.
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|arret|arrêt)\s*[.!]?\s*$/i;
const START = /^\s*(start|unstop|yes)\s*[.!]?\s*$/i;
export const isStopWord = (body) => STOP.test(body || '');
export const isStartWord = (body) => START.test(body || '');
