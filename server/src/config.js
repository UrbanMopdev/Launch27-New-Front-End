// Runtime configuration, with guards that keep non-production environments away from
// real customers and real data. See docs/environments.md and docs/security.md.

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

  // RingCentral: non-production must use the RingCentral sandbox platform.
  let ringcentralClientId = env.RINGCENTRAL_CLIENT_ID || null;
  const ringcentralServer = env.RINGCENTRAL_SERVER || null;
  if (!isProd && ringcentralClientId && !/devtest|sandbox/i.test(ringcentralServer || '')) {
    warnings.push('RingCentral disabled: outside production RINGCENTRAL_SERVER must be the RingCentral sandbox (platform.devtest.ringcentral.com).');
    ringcentralClientId = null;
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
    workerIntervalMs: Number(env.INBOX_WORKER_INTERVAL_MS || 30_000),
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
  return errors;
}
