import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { openDb } from './db/index.js';
import { seed } from './inbox/seed.js';
import { tick } from './inbox/service.js';

const config = loadConfig();
if (config.production && !config.databaseUrl) {
  console.warn('DATABASE_URL is not set: the support workspace is using embedded storage in', config.pgliteDir, '- add a Railway Postgres before real use.');
}
const db = await openDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
await seed(db);
const app = createApp(config, { db });

// In production the server also hosts the built front end.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
app.use(express.static(webDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/l27') || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(webDist, 'index.html'), (err) => err && next());
});

// Background work: wake snoozed conversations, SLA warnings and breaches.
setInterval(() => {
  db.tx((q) => tick(q)).catch((err) => console.error('worker tick failed:', err.message));
}, config.workerIntervalMs).unref();

app.listen(config.port, () => {
  console.log(`Server on http://localhost:${config.port} -> ${config.l27BaseUrl} (writes ${config.allowWrites ? 'ON' : 'off'}; database ${db.kind})`);
});
