import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { configErrors, loadConfig } from './config.js';
import { createApp } from './app.js';
import { openDb } from './db/index.js';
import { createLogger } from './log.js';
import { createQaSender, createQaStore } from './qa/service.js';
import { createMockLaunch27 } from './mock/launch27.js';
import { SessionStore } from './sessions.js';
import { seed } from './inbox/seed.js';
import { loadSampleInbox } from './sample/inbox.js';
import { tick } from './inbox/service.js';

const config = loadConfig();
const log = createLogger({ level: config.logLevel, base: { env: config.appEnv, version: config.version } });
for (const w of config.warnings) log.warn(w);
const errors = configErrors(config);
if (errors.length) {
  for (const e of errors) log.error(`config: ${e}`);
  process.exit(1);
}

const db = await openDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir, migrate: config.migrateOnBoot, log });
await seed(db);

const sessions = new SessionStore({ db, secret: config.sessionSecret, log });
// QA can serve an anonymized copy of production data (sent by production); otherwise the
// synthetic Launch27 generates data.
const qaStore = config.l27Mode === 'mock' && !config.production ? createQaStore({ db, log }) : null;
if (qaStore) await qaStore.load();
const fetchImpl = config.l27Mode === 'mock' ? createMockLaunch27({ password: config.mockPassword, snapshot: () => qaStore?.current() || null }) : fetch;
const qaSender = createQaSender({ config, fetchImpl, log });
const jobs = { consecutiveFailures: 0, lastSuccessAt: null, lastError: null };
const app = createApp(config, { db, sessions, fetchImpl, log, jobs, qa: { store: qaStore, sender: qaSender } });
if (config.sampleData && config.l27Mode === 'mock') {
  await loadSampleInbox(db, { fetchImpl, baseUrl: config.l27BaseUrl, log: (level, msg, fields) => log[level](msg, fields) }).catch((err) => log.error('sample inbox failed', { error: err.message }));
}

// In production the server also hosts the built front end.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
app.use(express.static(webDist, { maxAge: '1h', index: false }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/l27') || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(webDist, 'index.html'), (err) => err && next());
});

// Background work: wake snoozed conversations, SLA warnings and breaches, expired sessions.
// Failures are logged and counted; /readyz reports the worker as failing after 5 in a row.
const worker = setInterval(async () => {
  try {
    await db.tx((q) => tick(q));
    await sessions.purgeExpired();
    if (jobs.consecutiveFailures) log.info('worker recovered', { after: jobs.consecutiveFailures });
    jobs.consecutiveFailures = 0;
    jobs.lastSuccessAt = new Date().toISOString();
  } catch (err) {
    jobs.consecutiveFailures += 1;
    jobs.lastError = err.message;
    log.error('worker tick failed', { error: err.message, consecutiveFailures: jobs.consecutiveFailures });
  }
}, config.workerIntervalMs);
worker.unref();

const server = app.listen(config.port, () => {
  log.info('server started', { port: config.port, l27: config.l27Mode, writes: config.allowWrites, notifications: config.notificationsMode, database: db.kind });
});

// Railway sends SIGTERM before replacing a deployment: finish in-flight requests, close the pool.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log.info('shutting down', { signal });
    clearInterval(worker);
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: String(err?.message || err), stack: err?.stack }));
