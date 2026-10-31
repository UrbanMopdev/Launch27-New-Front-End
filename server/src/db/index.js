import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

// One small interface over two engines:
//   - Postgres (pg) when DATABASE_URL is set: production on Railway.
//   - PGlite (Postgres compiled to WASM) otherwise: zero-setup local dev and tests.
//     PGLITE_DIR keeps data on disk; without it the database lives in memory.
// Both speak the same SQL with $1 placeholders and return { rows }.
export async function openDb({ databaseUrl, pgliteDir } = {}) {
  let db;
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl: /sslmode=require|railway\.app|rlwy\.net/.test(databaseUrl) && !/localhost|127\.0\.0\.1|\.internal/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
    db = {
      kind: 'postgres',
      query: (sql, params) => pool.query(sql, params),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({ query: (sql, params) => client.query(sql, params) });
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    if (pgliteDir) fs.mkdirSync(pgliteDir, { recursive: true });
    const lite = new PGlite(pgliteDir || undefined);
    // PGlite runs one statement at a time, so a simple queue keeps a transaction's
    // statements from interleaving with other requests.
    let chain = Promise.resolve();
    const serial = (fn) => {
      const run = chain.then(fn, fn);
      chain = run.catch(() => {});
      return run;
    };
    db = {
      kind: 'pglite',
      query: (sql, params) => serial(() => lite.query(sql, params)),
      tx: (fn) => serial(() => lite.transaction((t) => fn({ query: (sql, params) => t.query(sql, params) }))),
      close: () => lite.close(),
    };
  }
  await migrate(db);
  return db;
}

async function migrate(db) {
  if (db.kind === 'pglite') {
    // PGlite's query() takes one statement; exec() runs a script.
    for (const stmt of splitStatements(SCHEMA)) await db.query(stmt);
  } else {
    await db.query(SCHEMA);
  }
}

export function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Helpers
export const one = async (db, sql, params) => (await db.query(sql, params)).rows[0] || null;
export const many = async (db, sql, params) => (await db.query(sql, params)).rows;
export const json = (v) => (v === undefined ? null : JSON.stringify(v));
