-- Anonymized copies of production Launch27 data, used only by QA (see src/qa/).
-- Production builds and scrubs the copy; QA receives it here and serves it in place of
-- the generated synthetic data. Production never stores rows in this table.
CREATE TABLE IF NOT EXISTS qa_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_snapshots_latest ON qa_snapshots (received_at DESC);
