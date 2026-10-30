// Builds the redacted API catalog from capture/output/requests.jsonl.
// Run on its own (npm run catalog) to rebuild without crawling again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpointTemplate, redact } from './routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(HERE, 'output');
const DOCS = path.join(HERE, '..', 'docs');
const MAX_DEPTH = 8;

// Query values that are safe to show as examples; anything else is replaced by its type.
const SAFE_QUERY_VALUE = /^(\d{1,6}|true|false|asc|desc|\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?|[a-z_]{1,30})$/i;

// Response "shape": the same structure with every value replaced by its type.
export function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return ['…'];
    const merged = value.slice(0, 50).reduce((acc, item) => mergeShapes(acc, shapeOf(item, depth + 1)), undefined);
    return merged === undefined ? [] : [merged];
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '{…}';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return typeof value;
}

export function mergeShapes(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (!a.length) return b;
    if (!b.length) return a;
    return [mergeShapes(a[0], b[0])];
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = mergeShapes(a[k], v);
    return out;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  // Different kinds (e.g. "string" and "null"): keep a union of the simple names.
  const names = new Set([...describe(a).split('|'), ...describe(b).split('|')]);
  return [...names].sort().join('|');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function describe(shape) {
  if (typeof shape === 'string') return shape;
  return Array.isArray(shape) ? 'array' : 'object';
}

function parseBody(raw) {
  if (!raw || raw.startsWith('<')) return raw || null;
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

export function buildCatalog() {
  const lines = fs.readFileSync(path.join(OUTPUT, 'requests.jsonl'), 'utf8').split('\n').filter(Boolean);
  const pagesFile = path.join(OUTPUT, 'pages.json');
  const visited = fs.existsSync(pagesFile) ? JSON.parse(fs.readFileSync(pagesFile, 'utf8')) : [];
  const endpoints = new Map();

  for (const line of lines) {
    const entry = JSON.parse(line);
    const u = new URL(entry.url);
    const key = `${entry.method} ${endpointTemplate(entry.url)}`;
    const ep = endpoints.get(key) || {
      method: entry.method,
      endpoint: endpointTemplate(entry.url),
      auth: new Set(),
      statuses: new Set(),
      pages: new Set(),
      query: {},
      requestShape: undefined,
      responseShape: undefined,
      blocked: false,
      count: 0,
    };
    ep.count += 1;
    ep.pages.add(entry.page);
    if (entry.status) ep.statuses.add(entry.status);
    if (entry.auth) ep.auth.add(entry.auth);
    if (entry.blocked) ep.blocked = true;
    for (const [name, value] of u.searchParams) {
      ep.query[name] ??= new Set();
      if (ep.query[name].size < 5) ep.query[name].add(SAFE_QUERY_VALUE.test(value) ? value : `<${redact(value) === value ? 'string' : 'redacted'}>`);
    }
    const body = parseBody(entry.requestBody);
    if (body && typeof body === 'object') ep.requestShape = mergeShapes(ep.requestShape, shapeOf(body));
    if (entry.responseBody !== undefined && entry.responseBody !== null && typeof entry.responseBody === 'object') {
      ep.responseShape = mergeShapes(ep.responseShape, shapeOf(entry.responseBody));
    }
    endpoints.set(key, ep);
  }

  const list = [...endpoints.values()]
    .map((ep) => ({
      ...ep,
      auth: [...ep.auth],
      statuses: [...ep.statuses].sort(),
      pages: [...ep.pages].sort(),
      query: Object.fromEntries(Object.entries(ep.query).map(([k, v]) => [k, [...v]])),
    }))
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint) || a.method.localeCompare(b.method));

  const byPage = {};
  for (const ep of list) {
    for (const p of ep.pages) (byPage[p] ??= []).push(`${ep.method} ${ep.endpoint}${ep.blocked ? ' (blocked: write)' : ''}`);
  }
  const pages = [...new Map(visited.map((p) => [p.template, { template: p.template, heading: p.heading ? redact(p.heading) : null, title: p.title }])).values()].map((p) => ({
    ...p,
    requests: byPage[p.template] || [],
  }));

  const catalog = { generatedAt: new Date().toISOString(), pages, endpoints: list };
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'api-catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  fs.writeFileSync(path.join(DOCS, 'API.md'), toMarkdown(catalog));
  return { endpointCount: list.length, pageCount: pages.length };
}

function toMarkdown({ generatedAt, pages, endpoints }) {
  const out = [`# Launch27 admin API (captured)`, '', `Generated ${generatedAt} by \`npm run capture\`. Do not edit by hand.`, '', '## Pages', ''];
  for (const p of pages) {
    out.push(`### \`${p.template}\`${p.heading ? ` — ${p.heading}` : ''}`, '');
    out.push(...(p.requests.length ? p.requests.map((r) => `- \`${r}\``) : ['- (no API calls)']), '');
  }
  out.push('## Endpoints', '');
  for (const ep of endpoints) {
    out.push(`### \`${ep.method} ${ep.endpoint}\`${ep.blocked ? ' (write, blocked during capture)' : ''}`, '');
    out.push(`- Status: ${ep.statuses.join(', ') || 'n/a'} · Auth: ${ep.auth.join(', ') || 'none/cookie'} · Seen ${ep.count}×`);
    out.push(`- Pages: ${ep.pages.map((p) => `\`${p}\``).join(', ')}`);
    const q = Object.entries(ep.query);
    if (q.length) out.push(`- Query: ${q.map(([k, v]) => `\`${k}\` (${v.join(', ')})`).join('; ')}`);
    if (ep.requestShape) out.push('', '<details><summary>Request body</summary>', '', '```json', JSON.stringify(ep.requestShape, null, 2), '```', '</details>');
    if (ep.responseShape) out.push('', '<details><summary>Response shape</summary>', '', '```json', JSON.stringify(ep.responseShape, null, 2), '```', '</details>');
    out.push('');
  }
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { endpointCount, pageCount } = buildCatalog();
  console.log(`Catalog rebuilt: ${pageCount} pages, ${endpointCount} endpoints.`);
}
