#!/usr/bin/env node
// Post-deploy smoke test: node scripts/smoke.mjs https://qa.example.com
// Checks liveness, readiness (database + migrations + worker), that the web app is served,
// and that the API refuses unauthenticated requests. Exits non-zero on any failure.
// EXPECT_ENV (optional) makes it fail if the deployment reports a different environment,
// which catches a staging URL pointing at production or the other way round.

const base = (process.argv[2] || process.env.SMOKE_URL || '').replace(/\/$/, '');
if (!base) {
  console.error('usage: node scripts/smoke.mjs <base-url>');
  process.exit(2);
}
const expectEnv = (process.env.EXPECT_ENV || '').toLowerCase();
const failures = [];

async function get(path, attempts = 6) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  throw last;
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

await check('GET /healthz is 200', async () => {
  const r = await get('/healthz');
  must(r.status === 200, `status ${r.status}`);
  const body = await r.json();
  console.log(`     env=${body.env} version=${body.version || 'unknown'}`);
  if (expectEnv) must(body.env === expectEnv || (expectEnv === 'qa' && body.env === 'staging'), `expected env ${expectEnv}, got ${body.env}`);
});

await check('GET /readyz is 200 (database, migrations, worker)', async () => {
  const r = await get('/readyz');
  const body = await r.json().catch(() => ({}));
  must(r.status === 200, `status ${r.status} ${JSON.stringify(body.checks || {})}`);
  if (body.env && body.env !== 'production') {
    must(body.l27 === 'mock', `non-production must use synthetic Launch27 data, got ${body.l27}`);
    must(body.notifications === 'sandbox', `non-production must not send notifications, got ${body.notifications}`);
  }
});

await check('GET / serves the web app', async () => {
  const r = await get('/');
  must(r.status === 200, `status ${r.status}`);
  must((await r.text()).includes('<div id="root">'), 'no app root in HTML');
});

await check('GET /auth/me without a session is 401', async () => {
  const r = await get('/auth/me');
  must(r.status === 401, `status ${r.status}`);
});

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed against ${base}`);
  process.exit(1);
}
console.log(`\nAll smoke checks passed against ${base}`);
