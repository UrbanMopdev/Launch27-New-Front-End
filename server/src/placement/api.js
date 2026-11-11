// /api/placement/v1: the shared placement contract (contracts/placement/openapi.yaml).
// Callers (the Sales Hub) use a service token from PLACEMENT_TOKENS, not a staff login.
//
// Layers, in order, for every request (docs/placement.md, "Security"):
//   1. security headers (no caching, no sniffing, no framing, HSTS in production)
//   2. caller address allowlist (PLACEMENT_ALLOWED_IPS), when set
//   3. lockout after repeated bad tokens from one address
//   4. service token: SHA-256 compared in constant time; only hashes are stored in production
//   5. per-caller rate limits (bookings and holds tighter than reads)
//   6. the token's scope: actions (read / hold / book) and brands
//   7. the request checked against the contract; quotes and holds only usable by their caller
//   8. an audit row per request (who, what, result; no customer details)
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { requestSchemaName, validate, validateResponse } from 'placement-contract';
import { PlacementError } from './service.js';

const digest = (s) => createHash('sha256').update(String(s)).digest();
const ZERO = Buffer.alloc(32);

/**
 * The caller for a bearer token, or null. Every stored hash is compared (no early exit) in
 * constant time, so neither which token nor how much of it matched shows in the timing.
 */
export function callerFor(tokens, header) {
  const given = String(header || '').match(/^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/)?.[1];
  const g = given ? digest(given) : ZERO;
  let found = null;
  for (const [name, t] of tokens) {
    const hash = Buffer.isBuffer(t) ? t : t.hash || digest(t); // tests may pass raw tokens
    const match = timingSafeEqual(g, hash);
    if (match && given && !found) found = { name, actions: t.actions || new Set(['read', 'hold', 'book']), brands: t.brands || null };
  }
  return found;
}

// ---------- caller address allowlist ----------
const v4num = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
export function ipAllowed(list, ip) {
  if (!list?.length) return true;
  const addr = String(ip || '').replace(/^::ffff:/i, '');
  return list.some((e) => {
    if (e.v6) return addr.toLowerCase() === e.v6;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return false;
    const size = 2 ** (32 - e.bits);
    return Math.floor(v4num(addr) / size) === Math.floor(v4num(e.v4) / size);
  });
}

// ---------- fixed-window counters (one app instance) ----------
export function createLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key -> { n, reset }
  let sweep = 0;
  return {
    /** Counts one hit. Returns seconds to wait when over the limit, else 0. */
    hit(key) {
      const t = now();
      if (t - sweep > windowMs) {
        for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
        sweep = t;
      }
      const cur = hits.get(key);
      if (!cur || cur.reset <= t) {
        hits.set(key, { n: 1, reset: t + windowMs });
        return 0;
      }
      cur.n += 1;
      return cur.n > limit ? Math.ceil((cur.reset - t) / 1000) : 0;
    },
    /** Seconds left on a block without counting a hit. */
    blocked(key) {
      const cur = hits.get(key);
      const t = now();
      return cur && cur.reset > t && cur.n > limit ? Math.ceil((cur.reset - t) / 1000) : 0;
    },
  };
}

export const DEFAULT_LIMITS = {
  badTokens: { limit: 10, windowMs: 15 * 60_000 }, // per address
  all: { limit: 300, windowMs: 60_000 }, // per caller
  hold: { limit: 60, windowMs: 60_000 },
  book: { limit: 20, windowMs: 60_000 },
};

const ACTION_OF = { getHealth: 'read', getCatalog: 'read', createQuote: 'read', getAvailability: 'read', createHold: 'hold', releaseHold: 'hold', createBooking: 'book' };

export function createPlacementRouter({ placement, config, log = { warn() {}, info() {}, error() {} }, limits = DEFAULT_LIMITS, now = () => Date.now() }) {
  const r = express.Router();
  const badTokens = createLimiter({ ...limits.badTokens, now });
  // Refused requests from unknown callers are audited at most 5 a minute per address.
  const anonAudit = createLimiter({ limit: 5, windowMs: 60_000, now });
  const perCaller = { all: createLimiter({ ...limits.all, now }), hold: createLimiter({ ...limits.hold, now }), book: createLimiter({ ...limits.book, now }) };

  const error = (res, status, code, message, { retryable = false, details } = {}) =>
    res.status(status).json({ error: { code, message, retryable, ...(details ? { details } : {}) } });
  // The contract has no rate-limit code yet: 429 with a retryable platform_unavailable and Retry-After.
  const tooMany = (res, seconds) => {
    res.set('Retry-After', String(Math.max(1, seconds)));
    return error(res, 429, 'platform_unavailable', `Too many requests. Try again in ${Math.max(1, seconds)} seconds.`, { retryable: true });
  };

  // 1. Headers on every answer, errors included.
  r.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // 8. Audit: one row per request once it's answered. Never the body: no customer details.
  r.use((req, res, next) => {
    const started = now();
    res.on('finish', () => {
      const entry = {
        caller: req.caller?.name || null,
        ip: req.ip || null,
        method: req.method,
        operation: req.operationId || null,
        path: req.path.slice(0, 120),
        status: res.statusCode,
        code: res.locals.errorCode || null,
        ms: now() - started,
        ref: res.locals.ref || null,
      };
      if (!entry.caller && anonAudit.hit(`ip:${entry.ip}`)) return; // a flood of bad requests can't fill the table
      placement.audit?.(entry).catch((err) => log.warn('placement audit failed', { error: err.message }));
      if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429) log.warn('placement request refused', { ...entry });
    });
    next();
  });
  const origJson = express.response.json;
  r.use((req, res, next) => {
    // Remember the error code for the audit row.
    res.json = function json(body) {
      if (body?.error?.code) res.locals.errorCode = body.error.code;
      return origJson.call(this, body);
    };
    next();
  });

  // 2. Address allowlist, before anything else is looked at.
  r.use((req, res, next) => {
    if (!ipAllowed(config.placementAllowedIps, req.ip)) return error(res, 403, 'forbidden', 'This address may not use the placement API.');
    next();
  });

  // 3 + 4. Lockout, then the service token.
  r.use((req, res, next) => {
    const ipKey = `ip:${req.ip}`;
    const wait = badTokens.blocked(ipKey);
    if (wait) return tooMany(res, wait);
    const caller = callerFor(config.placementTokens, req.headers.authorization);
    if (!caller) {
      const w = badTokens.hit(ipKey);
      if (w) return tooMany(res, w);
      res.set('WWW-Authenticate', 'Bearer realm="placement"');
      return error(res, 401, 'unauthorized', 'Missing or unknown service token.');
    }
    req.caller = caller;
    next();
  });

  // The body is read only for an authenticated caller.
  r.use(express.json({ limit: '64kb', strict: true, type: ['application/json'] }));
  r.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') return error(res, 400, 'invalid_request', 'The body is not valid JSON.');
    if (err?.type === 'entity.too.large') return error(res, 413, 'invalid_request', 'The body is too large.');
    return next(err);
  });

  // Outside production, check our own answers against the contract and log any drift.
  const send = (res, operationId, status, body) => {
    if (!config.production) {
      const problems = validateResponse(operationId, status, body);
      if (problems.length) log.warn('placement response does not match the contract', { operationId, status, problems: problems.slice(0, 5) });
    }
    return body === undefined ? res.status(status).end() : res.status(status).json(body);
  };

  const handle = (operationId, fn) => async (req, res) => {
    req.operationId = operationId;
    const action = ACTION_OF[operationId];
    // 5. Rate limits per caller: everything, then the tighter ones for holds and bookings.
    const waitAll = perCaller.all.hit(req.caller.name);
    const waitOne = perCaller[action]?.hit(req.caller.name) || 0;
    if (waitAll || waitOne) return tooMany(res, Math.max(waitAll, waitOne));
    // 6. Scope: the action.
    if (!req.caller.actions.has(action)) return error(res, 403, 'forbidden', `This token may not ${action === 'book' ? 'book' : action === 'hold' ? 'hold slots' : 'read'}.`);
    // 7. The request itself.
    const schema = requestSchemaName(operationId);
    if (schema) {
      if (!req.is('application/json')) return error(res, 415, 'invalid_request', 'Send the body as application/json.');
      const problems = validate(schema, req.body);
      if (problems.length) return error(res, 400, 'invalid_request', 'The request does not match the placement contract.', { details: { problems: problems.slice(0, 20) } });
    }
    try {
      const [status, body] = await fn(req, res);
      send(res, operationId, status, body);
    } catch (err) {
      if (err instanceof PlacementError) return error(res, err.status, err.code, err.message, { retryable: err.retryable, details: err.details });
      log.error('placement request failed', { operationId, error: err.message, stack: err.stack });
      error(res, 500, 'internal', 'Something went wrong on our side.', { retryable: true });
    }
  };

  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  // 6. Scope: the brand named in the request (quotes and holds carry theirs; see the service).
  const brandOk = (caller, brand) => {
    if (caller.brands && !caller.brands.has(brand)) throw new PlacementError(403, 'forbidden', `This token may not place customers for ${brand}.`);
  };

  r.get('/health', handle('getHealth', async () => [200, await placement.health()]));

  r.get('/catalog', handle('getCatalog', async (req) => {
    const brand = typeof req.query.brand === 'string' ? req.query.brand : '';
    if (!brand) throw new PlacementError(400, 'invalid_request', 'brand is required.');
    brandOk(req.caller, brand);
    return [200, await placement.catalog(brand)];
  }));

  r.post('/quote', handle('createQuote', async (req, res) => {
    brandOk(req.caller, req.body.brand);
    const out = await placement.quote(req.body, req.caller);
    res.locals.ref = out.quote_id || null;
    return [200, out];
  }));

  r.get('/availability', handle('getAvailability', async (req, res) => {
    const { quote_id: quoteId, from, to } = req.query;
    if (typeof quoteId !== 'string' || !ID.test(quoteId) || !DATE.test(String(from || '')) || !DATE.test(String(to || ''))) throw new PlacementError(400, 'invalid_request', 'quote_id, from and to (YYYY-MM-DD) are required.');
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new PlacementError(400, 'invalid_request', 'limit must be 1 to 200.');
    res.locals.ref = quoteId;
    return [200, await placement.availability({ quote_id: quoteId, from: String(from), to: String(to), limit }, req.caller)];
  }));

  r.post('/holds', handle('createHold', async (req, res) => {
    const out = await placement.hold(req.body, req.caller);
    res.locals.ref = out.hold_id || null;
    return [201, out];
  }));

  r.delete('/holds/:id', handle('releaseHold', async (req, res) => {
    if (!ID.test(req.params.id)) throw new PlacementError(404, 'hold_not_found', 'No such hold.');
    res.locals.ref = req.params.id;
    await placement.release(req.params.id, req.caller);
    return [204, undefined];
  }));

  // The Idempotency-Key is checked before anything else (contract rule 5).
  r.post('/bookings', (req, res, next) => {
    const key = String(req.headers['idempotency-key'] || '');
    if (!/^[\x21-\x7e]{8,200}$/.test(key)) return error(res, 400, 'invalid_request', 'An Idempotency-Key header (8 to 200 printable characters) is required.');
    next();
  }, handle('createBooking', async (req, res) => {
    const { replay, booking } = await placement.book(req.body, String(req.headers['idempotency-key']), req.caller);
    res.locals.ref = booking?.booking_id ? `booking ${booking.booking_id}` : null;
    return [replay ? 200 : 201, booking];
  }));

  r.use((req, res) => error(res, 404, 'not_found', 'No such placement endpoint.'));
  return r;
}
