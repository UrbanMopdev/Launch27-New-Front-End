export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  return {
    port: Number(env.PORT || 8787),
    l27BaseUrl: (env.L27_BASE_URL || 'https://urbanmop.launch27.com').replace(/\/+$/, ''),
    sessionSecret: env.SESSION_SECRET || 'dev-only-secret',
    allowWrites: ['1', 'true', 'yes'].includes(String(env.L27_ALLOW_WRITES || '').toLowerCase()),
    production,
    // Support workspace
    databaseUrl: env.DATABASE_URL || null,
    // Without DATABASE_URL the workspace uses an embedded Postgres (PGlite) stored here.
    pgliteDir: env.PGLITE_DIR || '.data/pglite',
    adminEmails: env.ADMIN_EMAILS || '',
    supervisorEmails: env.SUPERVISOR_EMAILS || '',
    simulator: !['0', 'false', 'no'].includes(String(env.INBOX_SIMULATOR || '').toLowerCase()),
    ringcentralClientId: env.RINGCENTRAL_CLIENT_ID || null,
    ringcentralServer: env.RINGCENTRAL_SERVER || null,
    workerIntervalMs: Number(env.INBOX_WORKER_INTERVAL_MS || 30_000),
  };
}
