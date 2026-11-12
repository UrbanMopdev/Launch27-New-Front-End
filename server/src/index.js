import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { configErrors, loadConfig } from './config.js';
import { createApp } from './app.js';
import { openDb } from './db/index.js';
import { createLogger } from './log.js';
import { createQaSender, createQaStore } from './qa/service.js';
import { createMockLaunch27, SAMPLE_VERSION } from './mock/launch27.js';
import { SessionStore } from './sessions.js';
import { seed } from './inbox/seed.js';
import { loadSampleInbox } from './sample/inbox.js';
import { tick } from './inbox/service.js';
import { createSegments } from './segments/service.js';
import { createSchedule } from './schedule/service.js';
import { createReports } from './reports/service.js';
import { createWriteLog } from './writes.js';
import { createCommercial } from './commercial/service.js';
import { createWorkforce } from './commercial/workforce.js';
import { createPlacement } from './placement/service.js';
import { sandboxEmail } from './inbox/channels.js';
import { createGmailClient, createGmailConnector } from './inbox/email/gmail.js';
import { createEmailSync } from './inbox/email/sync.js';
import { createL27Client, createSyncBearer } from './inbox/lookup.js';
import { OUR_IDENTITIES } from './inbox/seed.js';

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
// QA can serve a copy of production data (contact details masked) (sent by production); otherwise the
// synthetic Launch27 generates data.
// A new QA copy (or clearing it) swaps the data underneath: rebuild planner, segments and reports from it.
let onQaChange = () => {};
const qaStore = config.l27Mode === 'mock' && !config.production ? createQaStore({ db, log, onChange: (why) => onQaChange(why) }) : null;
if (qaStore) await qaStore.load();
const fetchImpl = config.l27Mode === 'mock' ? createMockLaunch27({ password: config.mockPassword, snapshot: () => qaStore?.current() || null }) : fetch;
const qaSender = createQaSender({ config, fetchImpl, log });
const writes = createWriteLog({ db, log });
const segments = createSegments({ db, config, fetchImpl, log });
const schedule = createSchedule({ db, config, fetchImpl, log, writes, dataTag: () => (qaStore?.summary()?.created_at ? `qa:${qaStore.summary().created_at}:v8` : SAMPLE_VERSION) });
const reports = createReports({ db, config, fetchImpl, schedule, log });
const commercial = createCommercial({ reports, schedule });
const commercialPlan = createWorkforce({ db, schedule });
const placement = createPlacement({ db, config, fetchImpl, schedule, writes, log });
const jobs = { consecutiveFailures: 0, lastSuccessAt: null, lastError: null };
onQaChange = (why) => {
  (async () => {
    log.info('rebuilding planner, segments and reports for the new data', { why });
    await schedule.reset();
    await segments.reset();
    await Promise.all([schedule.start({ trigger: 'qa-copy', kind: 'full' }), segments.start({ trigger: 'qa-copy' }), reports.start()]);
  })().catch((err) => log.error('rebuild after QA copy failed', { error: err.message }));
};
// Started on different data than last time (new QA copy arrived while down, or sample data changed).
if (await schedule.dataChanged()) onQaChange('data changed since last start');
// Channels. Email: Gmail in production (sends replies, reads the mailboxes every minute);
// dev and QA get the sandbox email channel, so email conversations work end to end with
// nothing sent and no real mailbox read. SMS isn't connected yet.
const connectors = {};
let emailSync = null;
if (config.gmail) {
  const client = createGmailClient({ auth: config.gmail.auth });
  connectors.email = createGmailConnector({ client, mailboxes: config.gmail.mailboxes, fromName: config.gmail.fromName });
  const l27Client = createL27Client({ baseUrl: config.l27BaseUrl, fetchImpl });
  const syncBearer = createSyncBearer({ config, fetchImpl });
  emailSync = createEmailSync({
    db,
    client,
    mailboxes: config.gmail.mailboxes,
    ourIdentities: OUR_IDENTITIES.email,
    intervalMs: config.gmail.pollIntervalMs,
    identify: async (email) => l27Client.identify(await syncBearer(), 'email', email),
    log,
  });
  log.info('email connected (Gmail)', { mailboxes: config.gmail.mailboxes.accounts.length, send_as: config.gmail.mailboxes.sendAs.size });
} else if (!config.production) {
  connectors.email = sandboxEmail();
}
const app = createApp(config, { db, sessions, fetchImpl, log, jobs, connectors, qa: { store: qaStore, sender: qaSender }, segments, schedule, reports, writes, commercial, placement, commercialPlan });
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
    emailSync?.maybeRun()?.catch((err) => log.error('email sync failed', { error: err.message }));
    await sessions.purgeExpired();
    await segments.maybeRun();
    await schedule.maybeRun();
    await reports.maybeRun();
    await placement.purge();
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
