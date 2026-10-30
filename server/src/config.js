export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 8787),
    l27BaseUrl: (env.L27_BASE_URL || 'https://urbanmop.launch27.com').replace(/\/+$/, ''),
    sessionSecret: env.SESSION_SECRET || 'dev-only-secret',
    allowWrites: ['1', 'true', 'yes'].includes(String(env.L27_ALLOW_WRITES || '').toLowerCase()),
    production: env.NODE_ENV === 'production',
  };
}
