// Logs into the Launch27 admin portal, visits every page it can reach from the
// navigation, and records the API calls each page makes.
//
//   npm run capture                     # headless, logs in with L27_EMAIL/L27_PASSWORD
//   npm run capture -- --headed         # watch it; log in by hand if no credentials are set
//   npm run capture -- --start /admin/bookings --max-pages 50
//
// Raw output (contains customer data, gitignored): capture/output/
// Redacted catalog (safe to commit):                docs/api-catalog.json, docs/API.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { pageTemplate } from './routes.js';
import { buildCatalog } from './catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(HERE, 'output');
const AUTH_STATE = path.join(HERE, '.auth', 'state.json');
const MAX_BODY_CHARS = 200_000;

const { values: args } = parseArgs({
  options: {
    headed: { type: 'boolean', default: false },
    start: { type: 'string', default: process.env.L27_ADMIN_START || '/admin' },
    'max-pages': { type: 'string', default: '200' },
    'per-template': { type: 'string', default: '2' },
    'allow-writes': { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
  },
});

const BASE = (process.env.L27_BASE_URL || 'https://urbanmop.launch27.com').replace(/\/+$/, '');
const ORIGIN = new URL(BASE).origin;
const MAX_PAGES = Number(args['max-pages']);
const PER_TEMPLATE = Number(args['per-template']);

// Links the crawler must never follow: they log out, change data or download files.
const SKIP_LINK = /(log_?out|sign_?out|delete|remove|destroy|cancel|archive|deactivate|export|download|impersonat|\.(csv|pdf|xlsx?|zip)(\?|$))/i;
const LOGIN_REQUEST = /\/(latest|v\d+)\/login\b|\/login\b|\/sign_?in\b|\/session/i;

fs.mkdirSync(path.join(OUTPUT, 'screens'), { recursive: true });
fs.mkdirSync(path.dirname(AUTH_STATE), { recursive: true });
const rawFile = path.join(OUTPUT, 'requests.jsonl');
fs.writeFileSync(rawFile, '');

// CHROMIUM_PATH lets you use an already installed browser; otherwise run `npx playwright install chromium` once.
const browser = await chromium.launch({ headless: !args.headed, executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({
  storageState: !args.fresh && fs.existsSync(AUTH_STATE) ? AUTH_STATE : undefined,
  viewport: { width: 1440, height: 900 },
});

let currentPage = '(login)';

// Read-only by default: XHR/fetch calls that would change data are blocked and
// logged instead, so the catalog still shows them.
await context.route('**/*', async (route) => {
  const req = route.request();
  const isApi = ['xhr', 'fetch'].includes(req.resourceType());
  if (isApi && req.method() !== 'GET' && req.method() !== 'OPTIONS' && !args['allow-writes'] && !LOGIN_REQUEST.test(req.url())) {
    record({ page: currentPage, method: req.method(), url: req.url(), requestBody: req.postData(), blocked: true });
    return route.abort('blockedbyclient');
  }
  return route.continue();
});

context.on('response', async (response) => {
  const req = response.request();
  if (!['xhr', 'fetch'].includes(req.resourceType())) return;
  let body = null;
  try {
    const type = response.headers()['content-type'] || '';
    if (type.includes('json')) body = await response.json();
    else body = (await response.text()).slice(0, 2000);
  } catch {
    // Redirects and aborted requests have no body.
  }
  const authHeader = req.headers()['authorization'];
  record({
    page: currentPage,
    method: req.method(),
    url: req.url(),
    status: response.status(),
    auth: authHeader ? authHeader.split(' ')[0] : null,
    requestHeaders: pick(req.headers(), ['content-type', 'accept', 'x-requested-with']),
    requestBody: LOGIN_REQUEST.test(req.url()) ? '<login body omitted>' : req.postData(),
    responseBody: truncate(body),
  });
});

function record(entry) {
  fs.appendFileSync(rawFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k]).map((k) => [k, obj[k]]));
}

function truncate(body) {
  if (body == null) return body;
  const text = JSON.stringify(body);
  return text.length > MAX_BODY_CHARS ? { _truncated: true, preview: text.slice(0, MAX_BODY_CHARS) } : body;
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function hasPasswordField(page) {
  return (await page.locator('input[type="password"]').count()) > 0;
}

async function login(page) {
  await page.goto(BASE + args.start, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (!(await hasPasswordField(page))) return;

  if (process.env.L27_EMAIL && process.env.L27_PASSWORD) {
    console.log('Logging in with L27_EMAIL');
    await page.locator('input[type="email"], input[name*="email" i], input[name*="login" i], input[type="text"]').first().fill(process.env.L27_EMAIL);
    await page.locator('input[type="password"]').first().fill(process.env.L27_PASSWORD);
    await page.locator('button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")').first().click();
  } else if (args.headed) {
    console.log('No L27_EMAIL/L27_PASSWORD set: log in in the browser window (waiting up to 5 minutes).');
  } else {
    throw new Error('Login page shown and no credentials set. Set L27_EMAIL/L27_PASSWORD or run with --headed.');
  }

  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 5 * 60_000 });
  await settle(page);
  await context.storageState({ path: AUTH_STATE });
  console.log('Logged in; session saved for next run.');
  if (!page.url().startsWith(BASE + args.start)) {
    await page.goto(BASE + args.start, { waitUntil: 'domcontentloaded' });
    await settle(page);
  }
}

async function collectLinks(page) {
  const hrefs = await page.$$eval('a[href]', (links) => links.map((a) => a.href));
  const out = new Set();
  for (const href of hrefs) {
    let u;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    if (u.origin !== ORIGIN || SKIP_LINK.test(u.pathname + u.hash) || !/^https?:/.test(u.protocol)) continue;
    // Stay inside the admin area.
    if (!(u.pathname + u.hash).includes(args.start.replace(/\/+$/, ''))) continue;
    out.add(u.href);
  }
  return [...out];
}

const page = await context.newPage();
await login(page);

const queue = [page.url()];
const seenUrls = new Set();
const visitsPerTemplate = new Map();
const pages = [];

while (queue.length && pages.length < MAX_PAGES) {
  const url = queue.shift();
  if (seenUrls.has(url)) continue;
  seenUrls.add(url);

  const template = pageTemplate(url);
  const visits = visitsPerTemplate.get(template) || 0;
  if (visits >= PER_TEMPLATE) continue;
  visitsPerTemplate.set(template, visits + 1);

  currentPage = template;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await settle(page);
  } catch (err) {
    console.warn(`! ${url}: ${err.message}`);
    continue;
  }
  if (await hasPasswordField(page)) throw new Error(`Session lost at ${url} (login form shown). Re-run with --fresh.`);

  const title = await page.title();
  const heading = await page.locator('h1, h2').first().textContent({ timeout: 1000 }).catch(() => null);
  const screenshot = `screens/${String(pages.length).padStart(3, '0')}.png`;
  await page.screenshot({ path: path.join(OUTPUT, screenshot), fullPage: true }).catch(() => {});
  pages.push({ url, template, title, heading: heading?.trim() || null, screenshot });
  console.log(`[${pages.length}] ${template}  ${heading?.trim() || title}`);

  for (const link of await collectLinks(page)) {
    if (!seenUrls.has(link)) queue.push(link);
  }
}

fs.writeFileSync(path.join(OUTPUT, 'pages.json'), JSON.stringify(pages, null, 2));
await context.storageState({ path: AUTH_STATE });
await browser.close();

const { endpointCount } = buildCatalog();
console.log(`\nVisited ${pages.length} pages, found ${endpointCount} endpoints.`);
console.log('Catalog: docs/api-catalog.json and docs/API.md  |  Raw data + screenshots: capture/output/');
