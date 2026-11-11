// Checks a running app against the placement contract by calling it, the way the hub will.
//
// Read-only by default: health, catalog, quote, availability and error handling.
// `holds: true` also creates and releases a hold (no booking is written).
// `book: {...}` also books, replays the booking and checks idempotency. That WRITES a real
// customer and booking, so only point it at a sandbox or test company.
import { BASE_PATH, validateResponse } from './index.js';

const DAY = 24 * 60 * 60 * 1000;
const isoDate = (d) => d.toISOString().slice(0, 10);

/**
 * @param {object} o
 * @param {string} o.baseUrl   App origin, e.g. https://app.example.com (the /api/placement/v1 prefix is added)
 * @param {string} o.token     Service token for the app
 * @param {string} o.brand     A brand the app serves
 * @param {object} o.quoteRequest  A QuoteRequest the app should find serviceable
 * @param {number} [o.days=14] How many days of availability to ask for
 * @param {boolean} [o.holds=false] Create and release a hold
 * @param {object} [o.book]    { customer, answers?, placed_by? } to book for real (sandbox only)
 * @param {number} [o.timeoutMs=15000] Per-request timeout; a slow call fails its check
 * @returns {Promise<{name: string, ok: boolean, problems: string[]}[]>}
 */
export async function runConformance({ baseUrl, token, brand, quoteRequest, days = 14, holds = false, book = null, timeoutMs = 15000, fetchImpl = fetch }) {
  const results = [];
  const root = baseUrl.replace(/\/+$/, '') + BASE_PATH;
  const placedBy = book?.placed_by ?? { kind: 'system', id: 'conformance-check' };

  async function call(method, p, { body, headers = {}, auth = true } = {}) {
    const res = await fetchImpl(root + p, {
      method,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = text; }
    }
    return { status: res.status, body: json };
  }

  // Runs one check. `fn` returns problems; a thrown error counts as one.
  async function check(name, fn) {
    let problems;
    try {
      problems = (await fn()) ?? [];
    } catch (err) {
      problems = [`threw: ${err.message}`];
    }
    results.push({ name, ok: problems.length === 0, problems });
    return problems.length === 0;
  }

  function expect(operationId, res, statuses, extra = []) {
    const problems = [];
    if (!statuses.includes(res.status)) problems.push(`expected status ${statuses.join(' or ')}, got ${res.status}${res.body?.error ? ` (${res.body.error.code})` : ''}`);
    problems.push(...validateResponse(operationId, res.status, res.body));
    return problems.concat(extra.filter(Boolean));
  }

  function expectError(operationId, res, status, codes) {
    const code = res.body?.error?.code;
    return expect(operationId, res, [status], [codes.includes(code) ? null : `expected error ${codes.join(' or ')}, got ${code ?? 'none'}`]);
  }

  await check('health: valid and serves the brand', async () => {
    const res = await call('GET', '/health');
    return expect('getHealth', res, [200], [res.body?.brands?.includes(brand) ? null : `brands does not include ${brand}`]);
  });

  await check('auth: missing token is 401', async () => {
    const res = await call('GET', `/catalog?brand=${encodeURIComponent(brand)}`, { auth: false });
    return expectError('getCatalog', res, 401, ['unauthorized']);
  });

  let catalog = null;
  await check('catalog: valid for the brand', async () => {
    const res = await call('GET', `/catalog?brand=${encodeURIComponent(brand)}`);
    catalog = res.body;
    return expect('getCatalog', res, [200], [res.body?.brand === brand ? null : `brand is ${res.body?.brand}, expected ${brand}`]);
  });

  await check('catalog: unknown brand is brand_not_served', async () => {
    const res = await call('GET', '/catalog?brand=no-such-brand-xyz');
    return expectError('getCatalog', res, 422, ['brand_not_served']);
  });

  await check('quote: invalid body is invalid_request', async () => {
    const res = await call('POST', '/quote', { body: { brand } });
    return expectError('createQuote', res, 400, ['invalid_request']);
  });

  let quote;
  const quoted = await check('quote: valid and serviceable', async () => {
    const res = await call('POST', '/quote', { body: quoteRequest });
    quote = res.body;
    return expect('createQuote', res, [200], [res.body?.serviceable === true ? null : 'the test address should be serviceable']);
  });
  if (!quoted) return results;

  const from = new Date(Date.now() + DAY);
  const to = new Date(from.getTime() + (days - 1) * DAY);
  let slots = [];
  await check('availability: valid, slots inside the range', async () => {
    const res = await call('GET', `/availability?quote_id=${encodeURIComponent(quote.quote_id)}&from=${isoDate(from)}&to=${isoDate(to)}`);
    slots = res.body?.slots ?? [];
    const extra = [res.body?.quote_id === quote.quote_id ? null : 'quote_id does not match'];
    for (const s of slots) {
      const start = Date.parse(s.start);
      const end = Date.parse(s.end);
      if (!(end > start)) extra.push(`slot ${s.slot_token} ends before it starts`);
      // Allow a day either side for time zones.
      if (start < from.getTime() - DAY || start > to.getTime() + 2 * DAY) extra.push(`slot ${s.slot_token} is outside the requested dates`);
    }
    return expect('getAvailability', res, [200], extra);
  });

  await check('availability: "to" before "from" is invalid_request', async () => {
    const res = await call('GET', `/availability?quote_id=${encodeURIComponent(quote.quote_id)}&from=${isoDate(to)}&to=${isoDate(from)}`);
    return expectError('getAvailability', res, 400, ['invalid_request']);
  });

  await check('availability: more than 31 days is invalid_request', async () => {
    const far = new Date(from.getTime() + 40 * DAY);
    const res = await call('GET', `/availability?quote_id=${encodeURIComponent(quote.quote_id)}&from=${isoDate(from)}&to=${isoDate(far)}`);
    return expectError('getAvailability', res, 400, ['invalid_request']);
  });

  await check('availability: unknown quote is quote_not_found', async () => {
    const res = await call('GET', `/availability?quote_id=no-such-quote&from=${isoDate(from)}&to=${isoDate(to)}`);
    return expectError('getAvailability', res, 404, ['quote_not_found']);
  });

  if (!holds && !book) return results;
  if (!slots.length) {
    results.push({ name: 'holds: need at least one open slot', ok: false, problems: [`no slots between ${isoDate(from)} and ${isoDate(to)}`] });
    return results;
  }

  let hold;
  await check('holds: create a hold', async () => {
    const res = await call('POST', '/holds', { body: { slot_token: slots[0].slot_token, placed_by: placedBy } });
    hold = res.body;
    return expect('createHold', res, [201], [res.body?.slot?.slot_token === slots[0].slot_token ? null : 'held slot does not match']);
  });

  if (hold?.hold_id) {
    await check('holds: holding the same slot again is slot_unavailable', async () => {
      const res = await call('POST', '/holds', { body: { slot_token: slots[0].slot_token, placed_by: placedBy } });
      return expectError('createHold', res, 409, ['slot_unavailable']);
    });

    await check('holds: release is 204, twice', async () => {
      const first = await call('DELETE', `/holds/${encodeURIComponent(hold.hold_id)}`);
      const second = await call('DELETE', `/holds/${encodeURIComponent(hold.hold_id)}`);
      return [...expect('releaseHold', first, [204]), ...expect('releaseHold', second, [204])];
    });
  }

  await check('holds: unknown hold is hold_not_found', async () => {
    const res = await call('DELETE', '/holds/no-such-hold');
    return expectError('releaseHold', res, 404, ['hold_not_found']);
  });

  if (!book) return results;

  const key = `conformance-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const required = (catalog?.questions || []).filter((q) => q.required);
  if (required.length) {
    await check('bookings: missing required answers is invalid_request', async () => {
      const h = await call('POST', '/holds', { body: { slot_token: slots[0].slot_token, placed_by: placedBy } });
      if (h.status !== 201) return [`could not hold a slot: status ${h.status}`];
      const res = await call('POST', '/bookings', { body: { hold_id: h.body.hold_id, customer: book.customer, placed_by: placedBy }, headers: { 'idempotency-key': `${key}-noanswers` } });
      await call('DELETE', `/holds/${encodeURIComponent(h.body.hold_id)}`);
      const listed = res.body?.error?.details?.questions;
      return expectError('createBooking', res, 400, ['invalid_request']).concat(Array.isArray(listed) && required.every((q) => listed.includes(q.id)) ? [] : ['details.questions should list the unanswered required questions']);
    });
  }

  let bookingHold;
  let booking;
  let bookingBody;
  await check('bookings: book a held slot', async () => {
    const h = await call('POST', '/holds', { body: { slot_token: slots[0].slot_token, placed_by: placedBy } });
    if (h.status !== 201) return [`could not hold a slot to book: status ${h.status}`];
    bookingHold = h.body;
    bookingBody = { hold_id: bookingHold.hold_id, customer: book.customer, placed_by: placedBy, source: { channel: 'other', campaign: 'conformance-check' }, ...(book.answers ? { answers: book.answers } : {}) };
    const res = await call('POST', '/bookings', { body: bookingBody, headers: { 'idempotency-key': key } });
    booking = res.body;
    return expect('createBooking', res, [201], [res.body?.brand === brand ? null : `brand is ${res.body?.brand}`]);
  });
  if (!booking?.booking_id) return results;

  await check('bookings: same Idempotency-Key replays without booking again', async () => {
    const res = await call('POST', '/bookings', { body: bookingBody, headers: { 'idempotency-key': key } });
    return expect('createBooking', res, [200], [res.body?.booking_id === booking.booking_id ? null : 'replay returned a different booking_id']);
  });

  await check('bookings: same key, different body is idempotency_conflict', async () => {
    const res = await call('POST', '/bookings', { body: { ...bookingBody, access_notes: 'changed' }, headers: { 'idempotency-key': key } });
    return expectError('createBooking', res, 409, ['idempotency_conflict']);
  });

  await check('bookings: a used hold cannot book again', async () => {
    const res = await call('POST', '/bookings', { body: bookingBody, headers: { 'idempotency-key': `${key}-again` } });
    const code = res.body?.error?.code;
    const codes = ['hold_not_found', 'hold_expired', 'slot_unavailable'];
    return [...validateResponse('createBooking', res.status, res.body), ...(codes.includes(code) ? [] : [`expected ${codes.join(' or ')}, got status ${res.status} ${code ?? ''}`])];
  });

  await check('bookings: missing Idempotency-Key is invalid_request', async () => {
    const res = await call('POST', '/bookings', { body: bookingBody });
    return expectError('createBooking', res, 400, ['invalid_request']);
  });

  return results;
}

/** Prints results; returns true when all passed. */
export function report(results, log = console.log) {
  for (const r of results) {
    log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    for (const p of r.problems) log(`        ${p}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`\n${results.length - failed} passed, ${failed} failed`);
  return failed === 0;
}
