#!/usr/bin/env node
// Export Kustomer *configuration* (no customer data) so the support workspace can mirror it.
//
//   KUSTOMER_API_KEY=... node scripts/kustomer-export.mjs [out.json]
//   (or put KUSTOMER_API_KEY in a .env file in the current folder)
//
// Reads only settings: queues, routing, workflows / business rules, teams, users (name,
// email, role, status), agent statuses, schedules / business hours, SLAs, shortcuts,
// conversation attributes. It never requests customers, conversations or messages.
// Endpoints differ between Kustomer plans and API versions, so each is tried and the
// result (or the HTTP status) is recorded; nothing fails the whole export.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

if (!process.env.KUSTOMER_API_KEY && existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*KUSTOMER_API_KEY\s*=\s*['"]?([^'"\s]+)/);
    if (m) process.env.KUSTOMER_API_KEY = m[1];
  }
}
const KEY = process.env.KUSTOMER_API_KEY;
if (!KEY) {
  console.error('Set KUSTOMER_API_KEY (environment or .env in this folder).');
  process.exit(2);
}
const BASE = process.env.KUSTOMER_API_BASE || 'https://api.kustomerapp.com';
const OUT = process.argv[2] || 'kustomer-config.json';

// name -> candidate paths (first that answers 200 wins)
const ENDPOINTS = {
  queues: ['/v1/routing/queues', '/v1/queues'],
  routing_rules: ['/v1/routing/rules', '/v1/routing/queue-rules'],
  routing_settings: ['/v1/routing/settings', '/v1/settings/routing'],
  workflows: ['/v1/workflows'],
  business_rules: ['/v1/business-rules', '/v1/rules'],
  teams: ['/v1/teams'],
  users: ['/v1/users'],
  user_statuses: ['/v1/routing/statuses', '/v1/users/statuses', '/v1/statuses'],
  work_sessions: ['/v1/routing/work-sessions'],
  capacity: ['/v1/routing/capacity', '/v1/routing/work-item-capacity'],
  schedules: ['/v1/business-schedules', '/v1/schedules'],
  holidays: ['/v1/holidays'],
  slas: ['/v1/slas'],
  shortcuts: ['/v1/shortcuts'],
  snippets: ['/v1/snippets'],
  tags: ['/v1/tags'],
  conversation_klass: ['/v1/metadata/conversation', '/v1/klasses/conversation'],
  channels: ['/v1/channels', '/v1/brands'],
  roles: ['/v1/roles', '/v1/permission-sets'],
};

// Fields kept for users: enough to map agents, nothing personal beyond work identity.
const USER_FIELDS = ['id', 'name', 'displayName', 'email', 'roles', 'roleGroups', 'teams', 'status', 'userType', 'deleted', 'createdAt', 'updatedAt'];

async function get(path) {
  const all = [];
  let url = `${BASE}${path}${path.includes('?') ? '&' : '?'}pageSize=100`;
  for (let page = 0; page < 50 && url; page++) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${KEY}`, accept: 'application/json' } });
    if (!r.ok) return { status: r.status, error: (await r.text()).slice(0, 200) };
    const body = await r.json();
    const data = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : Array.isArray(body) ? body : [body];
    all.push(...data);
    const next = body?.links?.next;
    url = next ? (next.startsWith('http') ? next : `${BASE}${next}`) : null;
  }
  return { status: 200, data: all };
}

function slimUser(u) {
  const a = u?.attributes || u;
  const out = { id: u?.id };
  for (const f of USER_FIELDS) if (a?.[f] !== undefined) out[f] = a[f];
  if (u?.relationships?.teams) out.teams = u.relationships.teams.data?.map((t) => t.id);
  return out;
}

const result = { exported_at: new Date().toISOString(), base: BASE, endpoints: {} };
for (const [name, paths] of Object.entries(ENDPOINTS)) {
  let last = null;
  for (const path of paths) {
    last = { path, ...(await get(path)) };
    if (last.status === 200) break;
  }
  if (name === 'users' && last?.data) last.data = last.data.map(slimUser);
  result.endpoints[name] = last;
  console.log(`${name.padEnd(20)} ${last.status === 200 ? `${last.data.length} item(s)` : `HTTP ${last.status}`}  ${last.path}`);
}
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(`\nWrote ${OUT}. It contains configuration only: no customers, conversations or messages.`);
