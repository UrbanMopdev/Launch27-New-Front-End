-- Scheduling planner (src/schedule/). A frequent read-only sync stores a snapshot of the
-- schedule (cleaners, availability, past 13 weeks and next 8 weeks of visits); comparing
-- snapshots finds changes. Assignments are written to Launch27, never stored here.

CREATE TABLE IF NOT EXISTS schedule_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  taken_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL
);

-- "Changes to handle": one row per thing dispatch should look at.
CREATE TABLE IF NOT EXISTS schedule_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL,                 -- de-duplicates the same problem across syncs
  kind text NOT NULL,                -- moved | cancelled | cleaner_changed | availability | unassigned | outside_hours | double_booked | different_cleaner | cleaner_unavailable
  due date,                          -- the visit date it is about (sorts the list)
  visit_key text,
  customer_id bigint,
  cleaner_id bigint,
  title text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text,                   -- fixed | dismissed | gone (no longer true) | past
  resolved_by bigint REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_changes_open_key ON schedule_changes (key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS schedule_changes_open ON schedule_changes (due) WHERE resolved_at IS NULL;

-- Days the office marked a cleaner unavailable in this app.
CREATE TABLE IF NOT EXISTS schedule_unavailable (
  cleaner_id bigint NOT NULL,
  day date NOT NULL,
  note text,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cleaner_id, day)
);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  visits integer,
  cleaners integer,
  changes integer,
  error text
);
