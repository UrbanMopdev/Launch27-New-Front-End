# Database

Postgres 16 on Railway, one per environment. Locally, an embedded Postgres (PGlite) is
used when `DATABASE_URL` is empty.

## Migrations

Versioned SQL files in `server/migrations/`, named `NNNN_description.sql` and applied in
order:

```bash
npm run migrate              # apply pending migrations
npm run migrate:status       # list applied / pending / changed
npm run migrate:verify -w server   # exit 1 if anything is pending or edited (CI uses this)
```

How the runner (`server/src/db/migrate.js`) works:

- Applied migrations are recorded in `schema_migrations` with a SHA-256 checksum.
- Each migration runs in its own transaction: it applies completely or not at all.
- On Postgres it takes an advisory lock, so two deploys can't migrate at the same time.
- If an already-applied file has been edited, it refuses to run. **Never edit an applied
  migration**: add a new one.
- Railway runs migrations as a pre-deploy step; if one fails, the deploy is cancelled and
  the old release keeps running against the unchanged database.

### Validation

- CI applies every migration to an empty Postgres 16, applies them again (must be a
  no-op) and verifies nothing is pending.
- Unit tests check idempotency and that edited migrations are refused.
- A migration reaches production only after running on dev and then QA.

### Writing a migration that can't break production (expand / contract)

The previous release keeps running during a deploy and must keep working after the
migration, so that rollback is always possible:

1. **Expand:** add new tables/columns (nullable or with defaults), new indexes. Ship code
   that writes both old and new shapes.
2. **Migrate data** in a later migration or a one-off script, in batches.
3. **Contract:** only after a release no longer reads the old column, drop it in a later
   migration.

Avoid in a single release: renaming or dropping columns that the running code uses,
`NOT NULL` without a default on a big table, long table locks. Create indexes on large
tables with `CREATE INDEX CONCURRENTLY` in a migration of its own (the runner's
transaction doesn't allow it, so do it as a manual step documented in the PR).

### If a migration fails

1. The deploy stops on its own; production keeps the old code and the old schema
   (the failed migration's transaction was rolled back).
2. Read the pre-deploy logs in Railway to see the error.
3. If the failing file never applied anywhere (it failed in dev first), correct it.
   Once it has applied in any environment, leave it and add a new migration.
4. Never fix a schema by hand in production. If you must, write the exact SQL in a PR
   first and record it as a migration afterwards.

## Indexing

Indexes are part of migrations. Current ones cover the hot paths: work lists by
status/queue/assignee, messages by conversation and time, identity lookups by
channel+value, SLA deadlines, audit by entity, and sessions by expiry/user. When adding
a query to a list page, add an index for its filter + sort in the same PR and check it
with `EXPLAIN ANALYZE` on staging.

## Backups

- Railway Postgres: enable **Backups** on each database (Database service → Backups →
  schedule daily, keep at least 7 days; weekly for 4 weeks). Billable storage.
- Production: additionally take a manual backup before any risky migration (Backups →
  "Create backup").
- For an off-platform copy, a scheduled job can `pg_dump` production to private object
  storage. Not set up yet; needs a bucket and an owner.

## Restore

**Into production (disaster recovery):**

1. Announce downtime; set the `web` service replicas to 0 or pause it so nothing writes.
2. Railway → production Postgres → Backups → choose the backup → **Restore**. Railway
   restores into the volume (check the Railway docs for whether it replaces in place or
   creates a new volume in your plan).
3. Start `web` again; it runs `npm run migrate` (no-op if the backup is from the same
   release) and `/readyz` goes green.
4. Run `EXPECT_ENV=production node scripts/smoke.mjs <url>`.
5. Note what was lost between the backup time and the incident (conversations, notes).
   Launch27 data isn't affected: it lives in Launch27.

**Test restores:** quarterly, restore a production backup into a *new, temporary
production-environment database* (not dev or staging), check row counts, then delete it.

**Never restore production data into development or staging.**

## Test data

- Dev and QA databases start empty. Conversations come from the Channel simulator;
  Launch27 data from the synthetic generator.
- Seed data in code (`server/src/inbox/seed.js`) is configuration only: queues, routing
  rules, saved replies. No people.
- No production dumps in dev/QA, on laptops, or in CI.
