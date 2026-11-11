import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSpec, schemaNames, validate, validateResponse, requestSchemaName } from '../index.js';
import { runConformance } from '../conformance.js';
import { createFakeApp } from './fake-app.js';

const spec = loadSpec();

function refTarget(ref) {
  return ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], spec);
}

function* walk(node, at = '') {
  if (node && typeof node === 'object') {
    yield [at, node];
    for (const [k, v] of Object.entries(node)) yield* walk(v, `${at}/${k}`);
  }
}

test('every $ref in the spec resolves', () => {
  const broken = [];
  for (const [at, node] of walk(spec)) if (typeof node.$ref === 'string' && refTarget(node.$ref) === undefined) broken.push(`${at}: ${node.$ref}`);
  assert.deepEqual(broken, []);
});

test('every schema compiles', () => {
  for (const name of schemaNames()) assert.doesNotThrow(() => validate(name, {}), name);
});

test('every example is used and matches its schema', () => {
  const used = new Set();
  const problems = [];
  const checkContent = (where, content) => {
    const media = content?.['application/json'];
    if (!media?.examples) return;
    const schema = media.schema.$ref.split('/').pop();
    for (const [name, ex] of Object.entries(media.examples)) {
      used.add(ex.$ref);
      const value = ex.$ref ? refTarget(ex.$ref).value : ex.value;
      problems.push(...validate(schema, value).map((p) => `${where} example ${name}: ${p}`));
    }
  };
  for (const [p, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      checkContent(`${method} ${p} request`, op.requestBody?.content);
      for (const [status, r] of Object.entries(op.responses)) checkContent(`${method} ${p} ${status}`, (r.$ref ? refTarget(r.$ref) : r).content);
    }
  }
  assert.deepEqual(problems, []);
  const unused = Object.keys(spec.components.examples).filter((k) => !used.has(`#/components/examples/${k}`));
  assert.deepEqual(unused, [], 'examples nobody references');
});

test('schemas reject what the rules forbid', () => {
  const quote = spec.components.examples.Quote.value;
  const { price: _price, ...noPrice } = quote;
  assert.notDeepEqual(validate('Quote', noPrice), [], 'a serviceable quote needs a price');
  assert.notDeepEqual(validate('Quote', { brand: 'urbanmop', serviceable: false }), [], 'not serviceable needs a reason');
  assert.notDeepEqual(validate('Money', { amount_cents: 249.5, currency: 'CAD' }), [], 'money is whole cents');
  assert.notDeepEqual(validate('Slot', { slot_token: 's', start: 'tomorrow', end: 'later' }), [], 'times are RFC 3339');
  assert.notDeepEqual(validate('Error', { error: { code: 'oops', message: 'x', retryable: false } }), [], 'error codes are a fixed list');
  assert.notDeepEqual(validate('BrandKey', 'Urban Mop'), [], 'brand keys are lowercase slugs');
});

test('validateResponse checks the status as well as the body', () => {
  assert.deepEqual(validateResponse('releaseHold', 204, undefined), []);
  assert.notDeepEqual(validateResponse('releaseHold', 200, {}), []);
  assert.notDeepEqual(validateResponse('getHealth', 201, {}), []);
  assert.deepEqual(validateResponse('createHold', 409, { error: { code: 'slot_unavailable', message: 'gone', retryable: false } }), []);
  assert.equal(requestSchemaName('createBooking'), 'BookingRequest');
  assert.equal(requestSchemaName('getHealth'), null);
});

const quoteRequest = spec.components.examples.QuoteRequest.value;
const book = { customer: spec.components.examples.BookingRequest.value.customer, answers: [{ question_id: 'terms', value: true }], placed_by: { kind: 'system', id: 'test' } };

async function withApp(options, fn) {
  const server = createFakeApp(options);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections(); // fetch keeps connections alive
    server.close();
  }
}

test('conformance: the reference fake app passes every check, including holds and booking', async () => {
  const results = await withApp({}, (baseUrl) => runConformance({ baseUrl, token: 'test-token', brand: 'urbanmop', quoteRequest, holds: true, book }));
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.ok(results.some((r) => r.name === 'bookings: missing required answers is invalid_request'));
  assert.ok(results.length >= 18, `ran ${results.length} checks`);
});

test('conformance: read-only by default (no hold or booking calls)', async () => {
  const results = await withApp({}, (baseUrl) => runConformance({ baseUrl, token: 'test-token', brand: 'urbanmop', quoteRequest }));
  assert.ok(results.every((r) => r.ok));
  assert.ok(!results.some((r) => /^(holds|bookings):/.test(r.name)));
});

test('conformance: catches an app that breaks the contract', async () => {
  const tamper = (route, body) => {
    if (route === 'GET /availability' && body.slots) return { ...body, slots: body.slots.map(({ end: _end, ...s }) => s) };
    if (route === 'POST /bookings' && body.booking_id) return { ...body, price: { amount_cents: 249.0001, currency: 'CAD' } };
    return body;
  };
  const results = await withApp({ tamper }, (baseUrl) => runConformance({ baseUrl, token: 'test-token', brand: 'urbanmop', quoteRequest, holds: true, book }));
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  assert.ok(failed.includes('availability: valid, slots inside the range'), failed.join(', '));
  assert.ok(failed.includes('bookings: book a held slot'), failed.join(', '));
});

test('conformance: a wrong brand stops at the quote', async () => {
  const results = await withApp({}, (baseUrl) => runConformance({ baseUrl, token: 'test-token', brand: 'cleanbee', quoteRequest: { ...quoteRequest, brand: 'cleanbee' } }));
  assert.ok(!results.find((r) => r.name.startsWith('health')).ok);
  assert.ok(!results.find((r) => r.name === 'quote: valid and serviceable').ok);
  assert.ok(!results.some((r) => r.name.startsWith('availability')));
});
