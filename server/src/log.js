// Structured JSON logs (one line per event) with personal data removed.
// Railway collects stdout; JSON lines are searchable there (e.g. @level:error).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEYS = /pass(word)?|secret|token|bearer|authorization|cookie|session|api[-_]?key/i;
const PERSONAL_KEYS = /^(email|phone|name|first_name|last_name|address|full_address|to|from|body|comment|notes?)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;

export function redact(value, depth = 0) {
  if (value == null || depth > 5) return value;
  if (typeof value === 'string') return value.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[secret]' : PERSONAL_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function createLogger({ level = 'info', base = {}, write = (line) => process.stdout.write(line + '\n') } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const log = (lvl, msg, fields = {}) => {
    if ((LEVELS[lvl] ?? 0) < min) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg: redact(String(msg)), ...base, ...redact(fields) }));
  };
  return Object.assign(log, {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  });
}

/** Request log: method, path without query string (queries carry names/search terms), status, duration. */
export function requestLogger(log) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/healthz') return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      log(lvl, 'request', { method: req.method, path: req.path.replace(/\/\d{3,}(?=\/|$)/g, '/:id'), status: res.statusCode, ms: Math.round(ms) });
    });
    next();
  };
}
