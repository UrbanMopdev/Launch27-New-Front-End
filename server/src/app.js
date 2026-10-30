import express from 'express';
import cookieParser from 'cookie-parser';
import { SessionStore, COOKIE_MAX_AGE_MS } from './sessions.js';

const COOKIE = 'l27_session';
const UPSTREAM_TIMEOUT_MS = 30_000;
// Request headers worth passing through to Launch27. Cookies and auth never are.
const FORWARD_HEADERS = ['accept', 'content-type'];

export function createApp(config, { fetchImpl = fetch, sessions = new SessionStore() } = {}) {
  const app = express();
  // Behind Railway's (or any) HTTPS proxy: trust X-Forwarded-* so secure cookies work.
  app.set('trust proxy', 1);
  app.use(cookieParser(config.sessionSecret));

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
    res.json({ email: session.email, allowWrites: config.allowWrites });
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
      return res.status(403).json({ error: 'Writes to Launch27 are turned off (set L27_ALLOW_WRITES=true)' });
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

  return app;
}
