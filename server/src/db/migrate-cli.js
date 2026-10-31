// npm run migrate [-- status | verify]
//   (default) apply pending migrations — Railway runs this as the pre-deploy command
//   status    list migrations and their state
//   verify    exit 1 if anything is pending or an applied file was edited (CI / smoke checks)
import { loadConfig } from '../config.js';
import { openDb } from './index.js';
import { migrationStatus, runMigrations } from './migrate.js';

const cmd = process.argv[2] || 'up';
const config = loadConfig();
const db = await openDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir, migrate: false });
let code = 0;
try {
  if (cmd === 'up') {
    const applied = await runMigrations(db, { log: (m) => console.log(m) });
    console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
  } else if (cmd === 'status' || cmd === 'verify') {
    const status = await migrationStatus(db);
    for (const s of status) console.log(`${s.state.padEnd(8)} ${s.name}${s.appliedAt ? `  (${new Date(s.appliedAt).toISOString()})` : ''}`);
    if (cmd === 'verify' && status.some((s) => s.state !== 'applied')) {
      console.error('Migrations are not fully applied or an applied file changed.');
      code = 1;
    }
  } else {
    console.error(`Unknown command: ${cmd}`);
    code = 2;
  }
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  code = 1;
} finally {
  await db.close();
}
process.exit(code);
