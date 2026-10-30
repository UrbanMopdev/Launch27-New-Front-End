import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp(config);

// In production the server also hosts the built front end.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
app.use(express.static(webDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/l27')) return next();
  res.sendFile(path.join(webDist, 'index.html'), (err) => err && next());
});

app.listen(config.port, () => {
  console.log(`Server on http://localhost:${config.port} -> ${config.l27BaseUrl} (writes ${config.allowWrites ? 'ON' : 'off'})`);
});
