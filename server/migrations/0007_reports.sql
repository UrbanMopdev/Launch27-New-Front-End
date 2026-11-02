-- Scheduling and cleaner reports (src/reports/). A nightly read-only sync stores a year of
-- slimmed visits (bookings + check-in/out + ratings + cleaner pay) as one snapshot.
CREATE TABLE IF NOT EXISTS report_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  taken_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'done',   -- done | failed
  error text,
  data jsonb
);
