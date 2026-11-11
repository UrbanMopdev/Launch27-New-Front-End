// /api/placement/v1: the shared placement contract (contracts/placement/openapi.yaml).
// Callers (the Sales Hub) use a service token from PLACEMENT_TOKENS, not a staff login.
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { requestSchemaName, validate, validateResponse } from 'placement-contract';
import { PlacementError } from './service.js';

const digest = (s) => createHash('sha256').update(String(s)).digest();

/** The caller's name for a bearer token, or null. Compares hashes so timing reveals nothing. */
export function callerFor(tokens, header) {
  const given = String(header || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!given) return null;
  const g = digest(given);
  let found = null;
  for (const [name, tok] of tokens) if (timingSafeEqual(g, digest(tok)) && !found) found = name;
  return found;
}

export function createPlacementRouter({ placement, config, log = { warn() {}, info() {}, error() {} } }) {
  const r = express.Router();
  r.use(express.json({ limit: '100kb' }));

  const error = (res, status, code, message, { retryable = false, details } = {}) =>
    res.status(status).json({ error: { code, message, retryable, ...(details ? { details } : {}) } });

  // Malformed JSON from express.json().
  r.use((err, req, res, next) => (err?.type === 'entity.parse.failed' ? error(res, 400, 'invalid_request', 'The body is not valid JSON.') : next(err)));

  r.use((req, res, next) => {
    const caller = callerFor(config.placementTokens, req.headers.authorization);
    if (!caller) return error(res, 401, 'unauthorized', 'Missing or unknown service token.');
    req.caller = caller;
    next();
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
    const schema = requestSchemaName(operationId);
    if (schema) {
      const problems = validate(schema, req.body);
      if (problems.length) return error(res, 400, 'invalid_request', 'The request does not match the placement contract.', { details: { problems: problems.slice(0, 20) } });
    }
    try {
      const [status, body] = await fn(req);
      send(res, operationId, status, body);
    } catch (err) {
      if (err instanceof PlacementError) return error(res, err.status, err.code, err.message, { retryable: err.retryable, details: err.details });
      log.error('placement request failed', { operationId, error: err.message, stack: err.stack });
      error(res, 500, 'internal', 'Something went wrong on our side.', { retryable: true });
    }
  };

  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  r.get('/health', handle('getHealth', async () => [200, await placement.health()]));

  r.get('/catalog', handle('getCatalog', async (req) => {
    if (!req.query.brand) throw new PlacementError(400, 'invalid_request', 'brand is required.');
    return [200, await placement.catalog(String(req.query.brand))];
  }));

  r.post('/quote', handle('createQuote', async (req) => [200, await placement.quote(req.body, req.caller)]));

  r.get('/availability', handle('getAvailability', async (req) => {
    const { quote_id: quoteId, from, to } = req.query;
    if (!quoteId || !DATE.test(String(from || '')) || !DATE.test(String(to || ''))) throw new PlacementError(400, 'invalid_request', 'quote_id, from and to (YYYY-MM-DD) are required.');
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new PlacementError(400, 'invalid_request', 'limit must be 1 to 200.');
    return [200, await placement.availability({ quote_id: String(quoteId), from: String(from), to: String(to), limit })];
  }));

  r.post('/holds', handle('createHold', async (req) => [201, await placement.hold(req.body)]));

  r.delete('/holds/:id', handle('releaseHold', async (req) => {
    await placement.release(req.params.id);
    return [204, undefined];
  }));

  // The Idempotency-Key is checked before anything else (contract rule 5).
  r.post('/bookings', (req, res, next) => {
    const key = String(req.headers['idempotency-key'] || '');
    if (key.length < 8 || key.length > 200) return error(res, 400, 'invalid_request', 'An Idempotency-Key header (8 to 200 characters) is required.');
    next();
  }, handle('createBooking', async (req) => {
    const { replay, booking } = await placement.book(req.body, String(req.headers['idempotency-key']), req.caller);
    return [replay ? 200 : 201, booking];
  }));

  r.use((req, res) => error(res, 404, 'not_found', 'No such placement endpoint.'));
  return r;
}
