-- Crew Planner, part 1: the reference data the planner trusts more than Launch27
-- (docs/crew-planner.md). Cleaner profiles, client preferences (with a review queue) and
-- postal-code areas. Grace (planner) and admins edit them in the app.

-- One row per Launch27 cleaner (team) the office has said something about. Columns left
-- null fall back to what Launch27's title codes say (gender from (F)/(M), tier from (1)/(2)/(3)).
CREATE TABLE IF NOT EXISTS cp_cleaner_profile (
  cleaner_id bigint PRIMARY KEY,                  -- Launch27 team id
  display_name text,
  aliases jsonb NOT NULL DEFAULT '[]',            -- other names people use (Casey, TJ, Dom)
  gender text CHECK (gender IN ('F', 'M')),
  tier smallint CHECK (tier BETWEEN 1 AND 3),
  rating_pct numeric(5,2),                        -- admins only
  protected boolean NOT NULL DEFAULT false,       -- never take bookings away
  low_performer boolean NOT NULL DEFAULT false,   -- take bookings from them first
  employment text NOT NULL DEFAULT 'contractor' CHECK (employment IN ('employee', 'contractor', 'contractor_guaranteed')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'inactive')),
  crew_role text NOT NULL DEFAULT 'none' CHECK (crew_role IN ('none', 'lead', 'trainer', 'trainee')),
  prefers_job_types jsonb NOT NULL DEFAULT '[]',  -- prepaid, one_time, move_in_out
  note text,
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Client preferences: the planner's source of truth. Found ones (Launch27 tags and notes,
-- visit history) start as pending and only bind the planner once someone confirms them.
CREATE TABLE IF NOT EXISTS cp_client_pref (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id text NOT NULL,                        -- Launch27 customer id
  client_name text,
  type text NOT NULL CHECK (type IN ('PREF_CLEANER', 'AVOID_CLEANER', 'FEMALE_ONLY', 'NO_TRAINEES', 'CONSISTENT_CLEANER', 'FIXED_TIME', 'HOLD_UNPAID', 'PENDING_CANCEL')),
  cleaner_ids jsonb NOT NULL DEFAULT '[]',        -- in order of preference (first choice first)
  note text,
  source text NOT NULL CHECK (source IN ('launch27_tag', 'launch27_note', 'continuity_history', 'grace_manual')),
  source_text text,                               -- the tag or note line it came from
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  confirmed_by bigint REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  dedupe_key text UNIQUE,                         -- found prefs: never suggested twice (even after a reject)
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cp_client_pref_client ON cp_client_pref (client_id);
CREATE INDEX IF NOT EXISTS cp_client_pref_status ON cp_client_pref (status, active);

-- Postal-code areas (first three characters = FSA) used to keep a crew-day in one part of town.
CREATE TABLE IF NOT EXISTS cp_fsa_cluster (
  fsa text PRIMARY KEY,
  cluster text NOT NULL,
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cp_fsa_cluster (fsa, cluster) VALUES
  ('K1P', 'Central'), ('K1R', 'Central'), ('K1N', 'Central'), ('K1S', 'Central'), ('K1Y', 'Central'), ('K1Z', 'Central'), ('K2P', 'Central'), ('K1M', 'Central'),
  ('K1K', 'East inner'), ('K1L', 'East inner'), ('K1J', 'East inner'), ('K1G', 'East inner'), ('K1H', 'East inner'), ('K1B', 'East inner'),
  ('K1C', 'East outer / Orleans'), ('K1E', 'East outer / Orleans'), ('K1W', 'East outer / Orleans'), ('K4A', 'East outer / Orleans'),
  ('K1T', 'South'), ('K1V', 'South'), ('K1X', 'South'), ('K4M', 'South'), ('K4P', 'South'),
  ('K2A', 'West inner / Nepean'), ('K2B', 'West inner / Nepean'), ('K2C', 'West inner / Nepean'), ('K2G', 'West inner / Nepean'), ('K2E', 'West inner / Nepean'),
  ('K2J', 'Barrhaven'), ('K2H', 'Barrhaven'),
  ('K2K', 'Kanata / Stittsville'), ('K2L', 'Kanata / Stittsville'), ('K2M', 'Kanata / Stittsville'), ('K2T', 'Kanata / Stittsville'), ('K2W', 'Kanata / Stittsville'), ('K2V', 'Kanata / Stittsville'), ('K2S', 'Kanata / Stittsville')
ON CONFLICT (fsa) DO NOTHING;

-- Results of the last "Load seed" (what matched, what needs a person).
CREATE TABLE IF NOT EXISTS cp_seed_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report jsonb NOT NULL,
  run_by bigint REFERENCES users(id) ON DELETE SET NULL,
  run_at timestamptz NOT NULL DEFAULT now()
);
