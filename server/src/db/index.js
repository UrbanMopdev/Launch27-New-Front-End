import fs from 'node:fs';
import { runMigrations } from './migrate.js';

// One small interface over two engines:
//   - Postgres (pg) when DATABASE_URL is set: production on Railway.
//   - PGlite (Postgres compiled to WASM) otherwise: zero-setup local dev and tests.
//     PGLITE_DIR keeps data on disk; without it the database lives in memory.
// Both speak the same SQL with $1 placeholders and return { rows }.
// Migrations run on open unless `migrate: false` (the migrate CLI runs them itself).
export async function openDb({ databaseUrl, pgliteDir, migrate = true, log } = {}) {
  let db;
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl: /sslmode=require|railway\.app|rlwy\.net/.test(databaseUrl) && !/localhost|127\.0\.0\.1|\.internal/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // A dropped idle connection must not crash the process.
    pool.on('error', (err) => log?.('error', 'postgres pool error', { error: err.message }));
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
  if (migrate) await runMigrations(db, { log: (m) => log?.('info', m) });
  return db;
}

export { splitStatements } from './migrate.js';

// Helpers
export const one = async (db, sql, params) => (await db.query(sql, params)).rows[0] || null;
export const many = async (db, sql, params) => (await db.query(sql, params)).rows;
export const json = (v) => (v === undefined ? null : JSON.stringify(v));
