// An in-memory app that implements the placement contract. Used to test the conformance
// checker, and a small reference for how an app should behave (status codes, holds,
// idempotency). It has no real scheduling rules: two teams, two slots a day.
import http from 'node:http';
import crypto from 'node:crypto';
import { BASE_PATH, requestSchemaName, validate } from '../index.js';

const DAY = 24 * 60 * 60 * 1000;
const HOLD_MS = 10 * 60 * 1000;

/**
 * @param {object} [o]
 * @param {string} [o.token]
 * @param {string} [o.brand]
 * @param {(route: string, body: any) => any} [o.tamper] change a response body, to test the checker
 */
export function createFakeApp({ token = 'test-token', brand = 'urbanmop', tamper = (_r, b) => b } = {}) {
  const quotes = new Map();
  const holds = new Map(); // hold_id -> { slot, expires, used }
  const booked = new Set(); // slot_token
  const idempotency = new Map(); // key -> { fingerprint, booking }
  let nextId = 1;
  const id = (p) => `${p}_${nextId++}`;

  const err = (status, code, message, retryable = false) => ({ status, body: { error: { code, message, retryable } } });

  function slotsFor(quote, from, to) {
    const slots = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
      const date = new Date(t).toISOString().slice(0, 10);
      for (const [team, hour] of [['t_1', 9], ['t_2', 13]]) {
        const start = new Date(`${date}T${String(hour + 5).padStart(2, '0')}:00:00Z`);
        const end = new Date(start.getTime() + quote.duration_minutes * 60 * 1000);
        const slot = { slot_token: `${quote.quote_id}.${date}.${team}`, start: start.toISOString(), end: end.toISOString(), team: { id: team, name: `Team ${team.slice(2)}` } };
        if (!booked.has(slot.slot_token) && !activeHold(slot.slot_token)) slots.push(slot);
      }
    }
    return slots;
  }

  function activeHold(slotToken) {
    for (const h of holds.values()) if (h.slot.slot_token === slotToken && !h.used && h.expires > Date.now()) return h;
    return null;
  }

  function slotFromToken(token) {
    const [quoteId, date, team] = String(token).split('.');
    const quote = quotes.get(quoteId);
    if (!quote || !date || !team) return null;
    return slotsFor(quote, date, date).find((s) => s.slot_token === token) ?? (booked.has(token) || activeHold(token) ? 'taken' : null);
  }

  const routes = {
    'GET /health': () => ({ status: 200, body: { status: 'ok', platform: 'launch27', contract_version: '1.1.0', brands: [brand], capabilities: { holds: 'local' }, checked_at: new Date().toISOString() } }),

    'GET /catalog': ({ query }) => {
      if (query.get('brand') !== brand) return err(422, 'brand_not_served', 'This app does not serve that brand.');
      return { status: 200, body: { brand, currency: 'CAD', timezone: 'America/Toronto', frequencies: ['one_time', 'biweekly'], services: [{ code: 'standard', name: 'Standard clean', home_fields: [{ key: 'bedrooms', label: 'Bedrooms', required: true }], extras: [] }], questions: [{ id: 'terms', label: 'The customer accepts the terms of service', type: 'checkbox', required: true }] } };
    },

    'POST /quote': ({ body }) => {
      if (body.brand !== brand) return err(422, 'brand_not_served', 'This app does not serve that brand.');
      if (!body.address.postal_code.startsWith('K')) return { status: 200, body: { brand, serviceable: false, not_serviceable_reason: 'outside_service_area' } };
      const quote = { brand, serviceable: true, quote_id: id('q'), expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), duration_minutes: 180, price: { first_visit: { amount_cents: 24900, currency: 'CAD' }, lines: [], taxes_included: false } };
      quotes.set(quote.quote_id, quote);
      return { status: 200, body: quote };
    },

    'GET /availability': ({ query }) => {
      const from = query.get('from');
      const to = query.get('to');
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      if (!query.get('quote_id') || !dateRe.test(from ?? '') || !dateRe.test(to ?? '')) return err(400, 'invalid_request', 'quote_id, from and to are required.');
      const span = (Date.parse(to) - Date.parse(from)) / DAY;
      if (span < 0 || span > 31) return err(400, 'invalid_request', '"to" must be 0 to 31 days after "from".');
      const quote = quotes.get(query.get('quote_id'));
      if (!quote) return err(404, 'quote_not_found', 'No such quote.');
      return { status: 200, body: { quote_id: quote.quote_id, timezone: 'America/Toronto', slots: slotsFor(quote, from, to), generated_at: new Date().toISOString() } };
    },

    'POST /holds': ({ body }) => {
      const slot = slotFromToken(body.slot_token);
      if (slot === 'taken') return err(409, 'slot_unavailable', 'That slot was taken.');
      if (!slot) return err(404, 'not_found', 'No such slot.');
      const hold = { hold_id: id('h'), slot, expires_at: new Date(Date.now() + HOLD_MS).toISOString(), kind: 'local' };
      holds.set(hold.hold_id, { slot, expires: Date.now() + HOLD_MS, used: false, hold });
      return { status: 201, body: hold };
    },

    'DELETE /holds/:id': ({ params }) => {
      const h = holds.get(params.id);
      if (!h) return err(404, 'hold_not_found', 'No such hold.');
      h.used = true;
      return { status: 204 };
    },

    'POST /bookings': ({ body, headers }) => {
      const key = headers['idempotency-key'];
      if (!key || key.length < 8) return err(400, 'invalid_request', 'Idempotency-Key is required.');
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const seen = idempotency.get(key);
      if (seen) return seen.fingerprint === fingerprint ? { status: 200, body: seen.booking } : err(409, 'idempotency_conflict', 'That key was used with a different request.');
      if (!(body.answers || []).some((a) => a.question_id === 'terms' && a.value === true)) {
        return { status: 400, body: { error: { code: 'invalid_request', message: 'Answer the required questions.', retryable: false, details: { questions: ['terms'] } } } };
      }
      const h = holds.get(body.hold_id);
      if (!h || h.used) return err(404, 'hold_not_found', 'No such hold, or it was already used.');
      if (h.expires <= Date.now()) return err(410, 'hold_expired', 'The hold expired.');
      h.used = true;
      booked.add(h.slot.slot_token);
      const booking = { booking_id: id('b'), customer_id: id('c'), customer_created: true, platform: 'launch27', brand, start: h.slot.start, end: h.slot.end, price: { amount_cents: 24900, currency: 'CAD' }, status: 'confirmed' };
      idempotency.set(key, { fingerprint, booking });
      return { status: 201, body: booking };
    },
  };

  const operationIds = { 'POST /quote': 'createQuote', 'POST /holds': 'createHold', 'POST /bookings': 'createBooking' };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = ({ status, body }, route) => {
      if (body === undefined) return res.writeHead(status).end();
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(tamper(route, body)));
    };
    if (!url.pathname.startsWith(BASE_PATH)) return send(err(404, 'not_found', 'Not found.'));
    if (req.headers.authorization !== `Bearer ${token}`) return send(err(401, 'unauthorized', 'Missing or wrong service token.'));

    const sub = url.pathname.slice(BASE_PATH.length);
    let route = `${req.method} ${sub}`;
    const params = {};
    const holdMatch = sub.match(/^\/holds\/([^/]+)$/);
    if (holdMatch) {
      route = `${req.method} /holds/:id`;
      params.id = decodeURIComponent(holdMatch[1]);
    }
    const handler = routes[route];
    if (!handler) return send(err(404, 'not_found', 'Not found.'));

    let body;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(err(400, 'invalid_request', 'Body is not JSON.')); }
    }
    const opId = operationIds[route];
    if (opId) {
      const problems = validate(requestSchemaName(opId), body);
      if (problems.length) return send({ ...err(400, 'invalid_request', 'Invalid body.'), body: { error: { code: 'invalid_request', message: 'Invalid body.', retryable: false, details: { problems } } } });
    }
    try {
      send(handler({ query: url.searchParams, body, headers: req.headers, params }), route);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal', message: e.message, retryable: true } }));
    }
  });
}
