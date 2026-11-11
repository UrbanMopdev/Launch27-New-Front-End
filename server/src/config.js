// Runtime configuration, with guards that keep non-production environments away from
// real customers and real data. See docs/environments.md and docs/security.md.

// PLACEMENT_TOKENS: "name:token,name2:token2" -> Map(name -> token). Bad entries are kept as
// errors so configErrors() can refuse to start.
export function parsePlacementTokens(raw) {
  const tokens = new Map();
  const bad = [];
  for (const entry of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    const name = i > 0 ? entry.slice(0, i).trim() : '';
    const token = i > 0 ? entry.slice(i + 1).trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || token.length < 32) bad.push(name || '(unnamed)');
    else tokens.set(name, token);
  }
  return { tokens, bad };
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
  if (placement.tokens.size && l27Mode === 'live' && !(env.L27_PLACEMENT_EMAIL && env.L27_PLACEMENT_PASSWORD)) {
    warnings.push('PLACEMENT_TOKENS is set but L27_PLACEMENT_EMAIL / L27_PLACEMENT_PASSWORD are not: the placement API will answer platform_unavailable.');
  }

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
    // Support workspace
    databaseUrl: env.DATABASE_URL || null,
    pgliteDir: env.PGLITE_DIR || '.data/pglite',
    migrateOnBoot: env.MIGRATE_ON_BOOT === undefined ? true : truthy(env.MIGRATE_ON_BOOT),
    adminEmails: env.ADMIN_EMAILS || '',
    supervisorEmails: env.SUPERVISOR_EMAILS || '',
    simulator: env.INBOX_SIMULATOR === undefined ? !isProd : truthy(env.INBOX_SIMULATOR),
    // Sample inbox conversations on an empty database. Never in production.
    sampleData: !isProd && truthy(env.SAMPLE_DATA),
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
  if (config.placementBadTokens?.length) errors.push(`PLACEMENT_TOKENS: each entry must be name:token with a lowercase name and a token of at least 32 characters (check ${config.placementBadTokens.join(', ')}).`);
  return errors;
}
