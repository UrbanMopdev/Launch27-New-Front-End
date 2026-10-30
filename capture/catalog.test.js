import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeOf, mergeShapes } from './catalog.js';
import { pageTemplate, endpointTemplate, redact } from './routes.js';

test('shapes strip values and merge across samples', () => {
  const a = shapeOf([{ id: 1, name: 'Jo', team: null }, { id: 2, name: 'Al', team: { id: 3 } }]);
  assert.deepEqual(a, [{ id: 'number', name: 'string', team: 'null|object' }]);
  assert.deepEqual(mergeShapes({ a: 'string' }, { b: 'number' }), { a: 'string', b: 'number' });
});

test('templates collapse ids and dates', () => {
  assert.equal(endpointTemplate('https://x.launch27.com/v1/staff/bookings/123?x=1'), 'x.launch27.com/v1/staff/bookings/:id');
  assert.equal(pageTemplate('https://x.launch27.com/admin#/bookings/2026-10-30/55'), '/admin#/bookings/:date/:id');
});

test('redacts emails and phone numbers', () => {
  assert.equal(redact('Jo jo@ex.com +1 (416) 555-0100'), 'Jo <email> <phone>');
});
