// Versioned, forward-only SQL migrations.
//
// Files live in server/migrations as NNNN_name.sql and run in order, each in its own
// transaction. Applied versions are recorded in schema_migrations with a checksum, so an
// already-applied file that was edited later is detected and the run fails instead of
// silently diverging. On Postgres an advisory lock stops two deploys migrating at once.
//
// Rules (see docs/database.md): never edit an applied migration — add a new one; make
// changes backwards compatible with the previous release (expand → migrate → contract).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const LOCK_KEY = 727_270_001; // arbitrary, constant advisory-lock id for this app

export function loadMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return { version: file.slice(0, 4), name: file.replace(/\.sql$/, ''), sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

// PGlite's query() takes one statement at a time. Comments (whole-line and trailing) are
// removed first so a ';' inside a comment doesn't split a statement. Migrations must not
// put '--' or ';' inside string literals.
export function splitStatements(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function ensureTable(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

export async function migrationStatus(db, migrations = loadMigrations()) {
  await ensureTable(db);
  const applied = new Map((await db.query('SELECT version, name, checksum, applied_at FROM schema_migrations')).rows.map((r) => [r.version, r]));
  return migrations.map((m) => {
    const a = applied.get(m.version);
    return { version: m.version, name: m.name, state: !a ? 'pending' : a.checksum === m.checksum ? 'applied' : 'changed', appliedAt: a?.applied_at || null };
  });
}

/** Apply pending migrations. Returns the names applied. Throws if an applied file changed. */
export async function runMigrations(db, { migrations = loadMigrations(), log = () => {} } = {}) {
  const lock = db.kind === 'postgres';
  if (lock) await db.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    const status = await migrationStatus(db, migrations);
    const changed = status.filter((s) => s.state === 'changed');
    if (changed.length) throw new Error(`Applied migration(s) were edited: ${changed.map((c) => c.name).join(', ')}. Add a new migration instead.`);
    const applied = [];
    for (const m of migrations) {
      if (status.find((s) => s.version === m.version)?.state !== 'pending') continue;
      log(`applying ${m.name}`);
      await db.tx(async (q) => {
        if (db.kind === 'pglite') for (const stmt of splitStatements(m.sql)) await q.query(stmt);
        else await q.query(m.sql);
        await q.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
      });
      applied.push(m.name);
    }
    return applied;
  } finally {
    if (lock) await db.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}
