import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const config = { l27BaseUrl: 'https://l27.invalid', sessionSecret: 's', allowWrites: false, production: false };

// Fake Launch27: accepts one login and one bearer token.
function fakeLaunch27() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/latest/login')) {
      const { password } = JSON.parse(init.body);
      return Response.json(password === 'right' ? { bearer: 'tok' } : { error: 'bad credentials' }, { status: password === 'right' ? 200 : 401 });
    }
    if (init.headers.authorization !== 'Bearer tok') return Response.json({ error: 'unauthorized' }, { status: 401 });
    return Response.json([{ id: 1 }]);
  };
  return { calls, fetchImpl };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

async function login(base, password = 'right') {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.c', password }),
  });
  return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

test('proxies GETs with the bearer from login', async () => {
  const l27 = fakeLaunch27();
  await withServer(createApp(config, { fetchImpl: l27.fetchImpl }), async (base) => {
    const { cookie } = await login(base);
    const res = await fetch(`${base}/l27/v1/staff/bookings?from=2026-10-30&to=2026-10-30`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ id: 1 }]);
    assert.equal(l27.calls.at(-1).url, 'https://l27.invalid/v1/staff/bookings?from=2026-10-30&to=2026-10-30');
  });
});

test('rejects bad credentials and unauthenticated proxy calls', async () => {
  const l27 = fakeLaunch27();
  await withServer(createApp(config, { fetchImpl: l27.fetchImpl }), async (base) => {
    const { res } = await login(base, 'wrong');
    assert.equal(res.status, 401);
    assert.equal((await fetch(`${base}/l27/v1/staff/bookings`)).status, 401);
    assert.equal((await fetch(`${base}/auth/me`)).status, 401);
  });
});

test('blocks writes unless allowed', async () => {
  const l27 = fakeLaunch27();
  await withServer(createApp(config, { fetchImpl: l27.fetchImpl }), async (base) => {
    const { cookie } = await login(base);
    const res = await fetch(`${base}/l27/v1/staff/bookings/1`, { method: 'PUT', headers: { cookie }, body: '{}' });
    assert.equal(res.status, 403);
    assert.ok(!l27.calls.some((c) => c.init.method === 'PUT'));
  });
});

test('logout ends the session', async () => {
  const l27 = fakeLaunch27();
  await withServer(createApp(config, { fetchImpl: l27.fetchImpl }), async (base) => {
    const { cookie } = await login(base);
    assert.equal((await fetch(`${base}/auth/me`, { headers: { cookie } })).status, 200);
    await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal((await fetch(`${base}/auth/me`, { headers: { cookie } })).status, 401);
  });
});
