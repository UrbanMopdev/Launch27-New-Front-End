-- Commercial workforce plan (src/commercial/workforce.js, docs/commercial-workforce.md).
-- UrbanMop is moving Commercial visits to a dedicated Commercial team. These tables hold only
-- the team's choices; hours, days off and bookings are read live from the planner's snapshot.

-- Who is on the Commercial team. No row = the app's suggestion (share of Commercial hours).
CREATE TABLE IF NOT EXISTS commercial_cleaners (
  cleaner_id bigint PRIMARY KEY,       -- Launch27 team id
  commercial boolean,                  -- null = follow the suggestion
  last_day date,                       -- last working day; not offered after it
  set_by bigint,
  set_at timestamptz NOT NULL DEFAULT now()
);

-- A recurring Commercial visit held by a cleaner outside the team: what was decided.
CREATE TABLE IF NOT EXISTS commercial_moves (
  series_key text PRIMARY KEY,         -- client | weekday | start | minutes | rhythm
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'done', 'hold')),
  assignee_id bigint,                  -- the Commercial cleaner chosen for it
  ends_on date,                        -- transition programs: when the client is expected to finish
  set_by bigint,
  set_at timestamptz NOT NULL DEFAULT now()
);

-- Rules and what partner files may show (one row).
CREATE TABLE IF NOT EXISTS commercial_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data jsonb NOT NULL DEFAULT '{}',
  set_by bigint,
  set_at timestamptz NOT NULL DEFAULT now()
);
