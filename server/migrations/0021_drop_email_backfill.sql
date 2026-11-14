-- Removes what the withdrawn Gmail historical backfill preview (migration 0020_email_backfill, taken
-- out of develop before release) created in the development database. Customer history will
-- come from Kustomer later instead. On databases that never had it this does nothing.
DROP TABLE IF EXISTS email_backfill_items;
DROP TABLE IF EXISTS email_backfill_mailboxes;
DROP TABLE IF EXISTS email_backfill_jobs;
-- The withdrawn migration's record, so its version number doesn't look like an edited file.
DELETE FROM schema_migrations WHERE version = '0020' AND name = '0020_email_backfill';
