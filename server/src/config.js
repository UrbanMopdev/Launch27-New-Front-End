import { createHash } from 'node:crypto';
import { brandKey } from './placement/mapping.js';
import { parseMailboxes, parseServiceAccount } from './inbox/email/gmail.js';

// Runtime configuration, with guards that keep non-production environments away from
// real customers and real data. See docs/environments.md and docs/security.md.

// PLACEMENT_TOKENS: the service tokens the Sales Hub (and any other caller) uses. Three forms:
//   name:sha256:<64 hex>                 only the token's SHA-256 is stored (required in production)
//   [{"name","sha256","actions","brands"}] JSON, with each token's scope
//   name:<raw token, 32+ characters>     development and QA only
// actions: read (health, catalog, quote, availability), hold (hold, release), book.
// brands: contract brand keys (urbanmop-residential). Omitted = every action / every served brand.
// Bad entries are kept as errors so configErrors() refuses to start.
export const PLACEMENT_ACTIONS = ['read', 'hold', 'book'];
const sha256Hex = (s) => createHash('sha256').update(String(s)).digest('hex');
export function parsePlacementTokens(raw) {
  const tokens = new Map(); // name -> { hash: Buffer, actions: Set, brands: Set | null, raw: boolean }
  const bad = [];
  const add = ({ name, hash, actions, brands, raw }) => {
    const okName = /^[a-z0-9][a-z0-9-]{0,39}$/.test(name || '');
    const okHash = /^[0-9a-f]{64}$/.test(hash || '');
    const acts = actions == null ? PLACEMENT_ACTIONS : actions;
    const okActs = Array.isArray(acts) && acts.length > 0 && acts.every((a) => PLACEMENT_ACTIONS.includes(a));
    const okBrands = brands == null || (Array.isArray(brands) && brands.length > 0 && brands.every((b) => /^[a-z0-9-]{1,60}$/.test(b)));
    if (!okName || !okHash || !okActs || !okBrands || tokens.has(name)) return bad.push(name || '(unnamed)');
    tokens.set(name, { hash: Buffer.from(hash, 'hex'), actions: new Set(acts), brands: brands ? new Set(brands) : null, raw: !!raw, scoped: actions != null && brands != null });
  };
  const text = String(raw || '').trim();
  if (text.startsWith('[')) {
    let list;
    try {
      list = JSON.parse(text);
    } catch {
      return { tokens, bad: ['(PLACEMENT_TOKENS is not valid JSON)'] };
    }
    for (const t of Array.isArray(list) ? list : []) add({ name: t?.name, hash: String(t?.sha256 || '').toLowerCase(), actions: t?.actions, brands: t?.brands });
    return { tokens, bad };
  }
  for (const entry of text.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    const name = i > 0 ? entry.slice(0, i).trim() : '';
    const rest = i > 0 ? entry.slice(i + 1).trim() : '';
    if (rest.startsWith('sha256:')) add({ name, hash: rest.slice(7).toLowerCase() });
    else if (rest.length >= 32) add({ name, hash: sha256Hex(rest), raw: true });
    else bad.push(name || '(unnamed)');
  }
  return { tokens, bad };
}

// PLACEMENT_ALLOWED_IPS: optional allowlist of caller addresses (IPv4, IPv4/CIDR or exact IPv6).
export function parseIpList(raw) {
  const list = [];
  const bad = [];
  for (const e of String(raw || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = e.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/);
    if (m && m[1].split('.').every((o) => Number(o) <= 255) && (m[2] === undefined || Number(m[2]) <= 32)) list.push({ v4: m[1], bits: m[2] === undefined ? 32 : Number(m[2]) });
    else if (/^[0-9a-f:]+$/i.test(e) && e.includes(':')) list.push({ v6: e.toLowerCase() });
    else bad.push(e);
  }
  return { list, bad };
}

const truthy = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
const ENVS = ['development', 'staging', 'production'];

export function resolveAppEnv(env) {
  const raw = (env.APP_ENV || env.RAILWAY_ENVIRONMENT_NAME || (env.NODE_ENV === 'production' ? 'production' : 'development')).toLowerCase();
  if (raw === 'qa' || raw === 'stage') return 'staging';
  if (raw === 'dev') return 'development';
  if (raw === 'prod') return 'production';
  return ENVS.includes(raw) ? raw : 'development';
}

export function loadConfig(env = process.env) {
  const appEnv = resolveAppEnv(env);
  const isProd = appEnv === 'production';
  const onRailway = !!env.RAILWAY_ENVIRONMENT_NAME;
  const warnings = [];

  // Launch27: 'live' talks to the real tenant; 'mock' serves synthetic data in-process.
  // Hosted dev/QA environments are always 'mock' — Launch27 holds real customer data and
  // has no test tenant, and live writes notify real customers.
  let l27Mode = (env.L27_MODE || (isProd ? 'live' : onRailway ? 'mock' : 'live')).toLowerCase() === 'mock' ? 'mock' : 'live';
  if (!isProd && onRailway && l27Mode === 'live') {
    warnings.push(`L27_MODE=live is not allowed in the hosted ${appEnv} environment; using mock data.`);
    l27Mode = 'mock';
  }

  // Writes to the live Launch27 only in production (and only when explicitly enabled).
  // Writes to the mock are always allowed — that's how QA tests editing flows safely.
  let allowWrites = l27Mode === 'mock' ? true : truthy(env.L27_ALLOW_WRITES);
  if (l27Mode === 'live' && !isProd && allowWrites) {
    warnings.push('L27_ALLOW_WRITES ignored outside production: live Launch27 writes notify real customers.');
    allowWrites = false;
  }

  // Outbound customer messages (email/SMS connectors): 'live' only in production.
  let notificationsMode = (env.NOTIFICATIONS_MODE || (isProd ? 'live' : 'sandbox')).toLowerCase() === 'live' ? 'live' : 'sandbox';
  if (!isProd && notificationsMode === 'live') {
    warnings.push(`NOTIFICATIONS_MODE=live is not allowed in ${appEnv}; outbound messages are recorded, not sent.`);
    notificationsMode = 'sandbox';
  }

  // RingCentral: non-production uses the RingCentral sandbox platform, unless
  // RINGCENTRAL_LIVE_OUTSIDE_PROD=true lets agents sign in with their real logins there.
  // Then the phone only rings and dials: the app keeps nothing about real calls outside
  // production (no call log, no caller lookup, no click-to-call from test data).
  let ringcentralClientId = env.RINGCENTRAL_CLIENT_ID || null;
  const ringcentralServer = env.RINGCENTRAL_SERVER || null;
  const ringcentralSandbox = /devtest|sandbox/i.test(ringcentralServer || '');
  let ringcentralRecord = true;
  if (!isProd && ringcentralClientId && !ringcentralSandbox) {
    if (truthy(env.RINGCENTRAL_LIVE_OUTSIDE_PROD)) {
      warnings.push(`RingCentral uses real logins in ${appEnv}: calls ring and can be made, but nothing about them is saved here.`);
      ringcentralRecord = false;
    } else {
      warnings.push('RingCentral disabled: outside production RINGCENTRAL_SERVER must be the RingCentral sandbox (platform.devtest.ringcentral.com), or set RINGCENTRAL_LIVE_OUTSIDE_PROD=true.');
      ringcentralClientId = null;
    }
  }

  const placement = parsePlacementTokens(env.PLACEMENT_TOKENS);
  const placementIps = parseIpList(env.PLACEMENT_ALLOWED_IPS);
  if (placement.tokens.size && l27Mode === 'live' && !(env.L27_PLACEMENT_EMAIL && env.L27_PLACEMENT_PASSWORD)) {
    warnings.push('PLACEMENT_TOKENS is set but L27_PLACEMENT_EMAIL / L27_PLACEMENT_PASSWORD are not: the placement API will answer platform_unavailable.');
  }

  // Portal switcher: this portal's name and links to the other brands' portals.
  // PORTALS="UrbanMop=https://a.example,Clean Bee=https://b.example" (https only).
  const portalName = (env.PORTAL_NAME || 'UrbanMop').trim().slice(0, 40);
  const portalLinks = String(env.PORTALS || '')
    .split(',')
    .map((part) => {
      const i = part.indexOf('=');
      if (i < 1) return null;
      const name = part.slice(0, i).trim().slice(0, 40);
      const url = part.slice(i + 1).trim();
      try {
        const u = new URL(url);
        return name && u.protocol === 'https:' ? { name, url: u.origin } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (env.PORTALS && portalLinks.length !== String(env.PORTALS).split(',').filter((x) => x.trim()).length) {
    warnings.push('Some PORTALS entries were ignored: each must be Name=https://address, separated by commas.');
  }

  // Email channel (Gmail). Production only: dev and QA must never read real customers' mail,
  // so they use the sandbox email channel (compose and thread, nothing sent or read).
  const gmailSet = !!(env.GMAIL_SERVICE_ACCOUNT_JSON || env.GMAIL_REFRESH_TOKEN);
  let gmail = null;
  if (gmailSet && !isProd) {
    warnings.push(`Gmail settings ignored in ${appEnv}: only production reads and sends real email. Email runs in sandbox mode here.`);
  } else if (gmailSet) {
    const serviceAccount = parseServiceAccount(env.GMAIL_SERVICE_ACCOUNT_JSON);
    const oauth = env.GMAIL_REFRESH_TOKEN && env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET ? { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, refreshToken: env.GMAIL_REFRESH_TOKEN } : null;
    const mailboxes = parseMailboxes(env.GMAIL_MAILBOXES);
    if (env.GMAIL_SERVICE_ACCOUNT_JSON && !serviceAccount) warnings.push('GMAIL_SERVICE_ACCOUNT_JSON is not a service-account key (needs client_email and private_key); email is not connected.');
    else if (!serviceAccount && !oauth) warnings.push('GMAIL_REFRESH_TOKEN also needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET; email is not connected.');
    else if (!mailboxes.accounts.length) warnings.push('GMAIL_MAILBOXES is empty: list the mailboxes to read and send from (e.g. info@urbanmop.ca,billing@urbanmop.ca); email is not connected.');
    else if (!serviceAccount && mailboxes.accounts.length > 1) warnings.push('A Gmail refresh token signs in to one mailbox; list the others as send-as aliases (alias=mailbox) or use a service account. Email is not connected.');
    else gmail = { auth: serviceAccount ? { serviceAccount } : oauth, mailboxes, fromName: env.EMAIL_FROM_NAME || 'UrbanMop', pollIntervalMs: Math.max(15_000, Number(env.EMAIL_POLL_INTERVAL_MS || 60_000)) };
  }

  if (isProd && !gmail && !gmailSet) warnings.push('Email is not connected: set GMAIL_SERVICE_ACCOUNT_JSON and GMAIL_MAILBOXES (docs/email.md). Email replies are saved, not sent.');

  return {
    appEnv,
    production: isProd,
    onRailway,
    version: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || env.GIT_SHA || 'local',
    port: Number(env.PORT || 8787),
    logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    l27Mode,
    l27BaseUrl: (env.L27_BASE_URL || 'https://urbanmop.launch27.com').replace(/\/+$/, ''),
    mockPassword: env.MOCK_PASSWORD || (isProd ? null : 'demo'),
    sessionSecret: env.SESSION_SECRET || 'dev-only-secret',
    allowWrites,
    notificationsMode,
    gmail,
    // Support workspace
    databaseUrl: env.DATABASE_URL || null,
    pgliteDir: env.PGLITE_DIR || '.data/pglite',
    migrateOnBoot: env.MIGRATE_ON_BOOT === undefined ? true : truthy(env.MIGRATE_ON_BOOT),
    adminEmails: env.ADMIN_EMAILS || '',
    supervisorEmails: env.SUPERVISOR_EMAILS || '',
    // Utilization report (read-only): everyone, production included. UTILIZATION_EMAILS, if set,
    // narrows it to those logins.
    utilizationEnabled: true,
    utilizationEmails: String(env.UTILIZATION_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
    simulator: env.INBOX_SIMULATOR === undefined ? !isProd : truthy(env.INBOX_SIMULATOR),
    // Sample inbox conversations on an empty database. Never in production.
    sampleData: !isProd && truthy(env.SAMPLE_DATA),
    portalName,
    portalLinks,
    ringcentralClientId,
    ringcentralServer,
    ringcentralRecord,
    workerIntervalMs: Number(env.INBOX_WORKER_INTERVAL_MS || 30_000),
    // QA copy of real data (contact details masked). Production sends (needs the QA URL and the shared
    // token); QA receives (needs the token). Never both: production can't receive one.
    qaSnapshotToken: env.QA_SNAPSHOT_TOKEN || null,
    qaSnapshotUrl: isProd ? env.QA_SNAPSHOT_URL || null : null,
    qaSnapshotReceive: !isProd && !!env.QA_SNAPSHOT_TOKEN,
    // Customer segments: the nightly update logs in as this read-only Launch27 staff user
    // (production only; dev and QA use their synthetic Launch27).
    l27SyncEmail: l27Mode === 'live' ? env.L27_SYNC_EMAIL || null : null,
    l27SyncPassword: l27Mode === 'live' ? env.L27_SYNC_PASSWORD || null : null,
    // Placement API for the Sales Hub (docs/placement.md). Off until PLACEMENT_TOKENS is set.
    placementTokens: placement.tokens,
    placementBadTokens: placement.bad,
    placementBrands: String(env.PLACEMENT_BRANDS || 'residential').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    placementPaymentMethod: env.PLACEMENT_PAYMENT_METHOD || 'check',
    // Production bookings need this switch, separate from L27_ALLOW_WRITES (staff screens).
    placementBookingEnabled: isProd ? truthy(env.PLACEMENT_BOOKING_ENABLED) : null,
    placementAllowedIps: placementIps.list,
    placementBadIps: placementIps.bad,
    // Bookings from placement are written as this Launch27 staff user (live only; mock signs in itself).
    l27PlacementEmail: l27Mode === 'live' ? env.L27_PLACEMENT_EMAIL || null : null,
    l27PlacementPassword: l27Mode === 'live' ? env.L27_PLACEMENT_PASSWORD || null : null,
    warnings,
  };
}

/** Problems that must stop the process from starting (returns messages; empty = ok). */
export function configErrors(config) {
  const errors = [];
  if (config.production) {
    if (!process.env.SESSION_SECRET || config.sessionSecret.length < 32) errors.push('SESSION_SECRET must be set to a random value of at least 32 characters in production.');
    if (!config.databaseUrl) errors.push('DATABASE_URL must be set in production (Railway Postgres reference variable).');
    if (config.l27Mode !== 'live') errors.push('L27_MODE must be live in production.');
    if (config.simulator) errors.push('INBOX_SIMULATOR must be off in production.');
  }
  if (config.onRailway && !config.production && !config.databaseUrl) errors.push(`DATABASE_URL must be set in the hosted ${config.appEnv} environment.`);
  if (config.l27Mode === 'mock' && !config.mockPassword) errors.push('MOCK_PASSWORD must be set when L27_MODE=mock.');
  if (config.qaSnapshotToken && config.qaSnapshotToken.length < 32) errors.push('QA_SNAPSHOT_TOKEN must be at least 32 characters.');
  if (config.placementBadTokens?.length) errors.push(`PLACEMENT_TOKENS: check ${config.placementBadTokens.join(', ')}. Each entry needs a lowercase name and name:sha256:<64 hex> (or, outside production, a token of 32+ characters); scopes must use actions read, hold, book.`);
  const placementTokens = [...(config.placementTokens?.entries() || [])];
  if (config.production && placementTokens.some(([, t]) => t.raw)) errors.push('PLACEMENT_TOKENS: production stores only token hashes (name:sha256:<64 hex>). Run `npm run placement-token` to make one.');
  // Production tokens say exactly what they may do: no implicit "everything".
  const unscoped = placementTokens.filter(([, t]) => !t.scoped).map(([n]) => n);
  if (config.production && unscoped.length) errors.push(`PLACEMENT_TOKENS: in production every token lists its actions and brands (JSON form). Check ${unscoped.join(', ')}.`);
  // A token's brands must be brands this app serves (PLACEMENT_BRANDS), written as brand keys.
  const served = new Set((config.placementBrands || []).map(brandKey));
  const wrongBrands = placementTokens.flatMap(([n, t]) => [...(t.brands || [])].filter((b) => !served.has(b)).map((b) => `${n}: ${b}`));
  if (wrongBrands.length) errors.push(`PLACEMENT_TOKENS: brands must be served brand keys (${[...served].join(', ') || 'none served'}). Check ${wrongBrands.join(', ')}.`);
  // Slot tokens are signed with SESSION_SECRET: hosted environments serving placement need a real one.
  if (placementTokens.length && config.onRailway && (!process.env.SESSION_SECRET || config.sessionSecret.length < 32)) errors.push('SESSION_SECRET must be a random value of at least 32 characters wherever the placement API is served.');
  if (config.placementBadIps?.length) errors.push(`PLACEMENT_ALLOWED_IPS: not an IP address or IPv4 range: ${config.placementBadIps.join(', ')}.`);
  return errors;
}

// Who sees the Utilization report: everyone, unless UTILIZATION_EMAILS narrows it.
export function canSeeUtilization(config, email) {
  if (!config?.utilizationEnabled) return false;
  const list = config.utilizationEmails || [];
  return !list.length || list.includes(String(email || '').toLowerCase());
}
