-- Monthly raise check (src/reports/service.js raiseDigest): a private bell notification to
-- admins for each cleaner who looks ready for a raise review. Nothing on screen for the team.

-- A notification can point at a page (not only a conversation).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link text;

-- One row per month the check ran, so it runs once a month.
CREATE TABLE IF NOT EXISTS raise_digests (
  month text PRIMARY KEY,            -- YYYY-MM
  sent_at timestamptz NOT NULL DEFAULT now(),
  cleaners jsonb NOT NULL DEFAULT '[]',
  recipients integer NOT NULL DEFAULT 0
);
