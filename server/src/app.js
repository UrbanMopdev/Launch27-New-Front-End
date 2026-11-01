import express from 'express';
import cookieParser from 'cookie-parser';
import { SessionStore, COOKIE_MAX_AGE_MS } from './sessions.js';
import { createInboxRouter } from './inbox/api.js';
import { tokenMatches } from './qa/service.js';
import { guardConnectors } from './inbox/channels.js';
import { createL27Client } from './inbox/lookup.js';
import { createLogger, requestLogger } from './log.js';
import { migrationStatus } from './db/migrate.js';

const COOKIE = 'l27_session';
const UPSTREAM_TIMEOUT_MS = 30_000;
// Request headers worth passing through to Launch27. Cookies and auth never are.
const FORWARD_HEADERS = ['accept', 'content-type'];

export function createApp(
  config,
  { fetchImpl = fetch, sessions = new SessionStore({ secret: config.sessionSecret }), db = null, connectors = {}, log = createLogger({ level: 'warn' }), jobs = null, qa = {} } = {},
) {
  const app = express();
  // Behind Railway's (or any) HTTPS proxy: trust X-Forwarded-* so secure cookies work.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(requestLogger(log));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // Liveness: the process is up. Never touches the database.
  app.get('/healthz', (req, res) => res.json({ status: 'ok', env: config.appEnv, version: config.version, uptimeSec: Math.round(process.uptime()) }));

  // Readiness: can serve traffic (database reachable, migrations applied, worker healthy).
  // Railway's health check uses this, so a deploy only goes live when it passes.
  app.get('/readyz', async (req, res) => {
    const checks = { database: 'skipped', migrations: 'skipped', worker: 'skipped' };
    let ok = true;
    if (db) {
      try {
        await db.query('SELECT 1');
        checks.database = 'ok';
        const pending = (await migrationStatus(db)).filter((m) => m.state !== 'applied');
        checks.migrations = pending.length ? `pending: ${pending.map((m) => m.name).join(', ')}` : 'ok';
        if (pending.length) ok = false;
      } catch (err) {
        checks.database = 'unreachable';
        ok = false;
        log('error', 'readiness: database check failed', { error: err.message });
      }
    }
    if (jobs) {
      checks.worker = jobs.consecutiveFailures >= 5 ? `failing (${jobs.consecutiveFailures} in a row)` : 'ok';
      if (jobs.consecutiveFailures >= 5) ok = false;
    }
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', env: config.appEnv, version: config.version, l27: config.l27Mode, notifications: config.notificationsMode, checks });
  });

  app.use(cookieParser(config.sessionSecret));
  // Load a persisted session (after a redeploy) before any route reads it.
  app.use(async (req, res, next) => {
    const id = req.signedCookies?.[COOKIE];
    if (id) await sessions.hydrate?.(id).catch((err) => log('error', 'session hydrate failed', { error: err.message }));
    next();
  });

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.production,
    signed: true,
    maxAge: COOKIE_MAX_AGE_MS,
  };

  // Same login call the check-in tracker uses: POST /latest/login -> { bearer }.
  // Each user signs in with their own Launch27 account, so Launch27 keeps
  // enforcing their permissions.
  app.post('/auth/login', express.json(), async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    let upstream;
    try {
      upstream = await fetchImpl(`${config.l27BaseUrl}/latest/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      return res.status(502).json({ error: `Could not reach Launch27: ${err.message}` });
    }

    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok || !body.bearer) {
      return res.status(upstream.status >= 400 ? upstream.status : 401).json({ error: body.error || body.message || 'Login failed' });
    }

    res.cookie(COOKIE, sessions.create(body.bearer, email), cookieOptions);
    res.json({ email });
  });

  app.get('/auth/me', (req, res) => {
    const session = sessions.get(req.signedCookies[COOKIE]);
    if (!session) return res.status(401).json({ error: 'Not logged in' });
    res.json({ email: session.email, allowWrites: config.allowWrites, env: config.appEnv, l27Mode: config.l27Mode, notificationsMode: config.notificationsMode });
  });

  app.post('/auth/logout', (req, res) => {
    sessions.delete(req.signedCookies[COOKIE]);
    res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
    res.status(204).end();
  });

  // Pass-through: /l27/v1/staff/bookings?from=... -> {L27_BASE_URL}/v1/staff/bookings?from=...
  // with the user's bearer token attached.
  app.use('/l27', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
    const session = sessions.get(req.signedCookies[COOKIE]);
    if (!session) return res.status(401).json({ error: 'Not logged in' });

    if (req.method !== 'GET' && !config.allowWrites) {
      return res.status(403).json({ error: config.production ? 'Writes to Launch27 are turned off (set L27_ALLOW_WRITES=true)' : `Writes to the live Launch27 are blocked in ${config.appEnv}` });
    }

    const headers = { authorization: `Bearer ${session.bearer}` };
    for (const name of FORWARD_HEADERS) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }

    let upstream;
    try {
      upstream = await fetchImpl(`${config.l27BaseUrl}${req.url}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) || !req.body?.length ? undefined : req.body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      return res.status(502).json({ error: `Could not reach Launch27: ${err.message}` });
    }

    // Launch27 rejected the token (expired or revoked): end our session too so
    // the UI sends the user back to the login screen.
    if (upstream.status === 401) sessions.delete(req.signedCookies[COOKIE]);

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.type(contentType);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  });

  // QA only: receive an anonymized copy of production data from production.
  if (config.qaSnapshotReceive && qa.store) {
    app.put('/qa/snapshot', express.json({ limit: '300mb' }), async (req, res) => {
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!tokenMatches(auth, config.qaSnapshotToken)) return res.status(401).json({ error: 'Not allowed' });
      try {
        const summary = await qa.store.save(req.body);
        res.json({ summary });
      } catch (err) {
        log.warn('QA copy refused', { error: err.message });
        res.status(422).json({ error: err.message });
      }
    });
  }

  // The support workspace (conversations, contacts, routing). Needs a database.
  if (db) {
    const l27 = createL27Client({ baseUrl: config.l27BaseUrl, fetchImpl });
    app.use('/api', createInboxRouter({ db, sessions, cookieName: COOKIE, config, l27, connectors: guardConnectors(connectors, config.notificationsMode), log, qa }));
  }

  // Last-resort error handler: log it (without personal data), answer generically.
  app.use((err, req, res, next) => {
    log('error', 'unhandled request error', { path: req.path, error: err.message, stack: err.stack });
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return app;
}
