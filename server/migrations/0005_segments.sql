-- Customer segments, worked out from Launch27 bookings (src/segments/).
-- A nightly sync (and an instant per-customer refresh after bookings made in this app)
-- stores each customer's current segment, every change between segments, and daily counts
-- so the customer list and trends load without calling Launch27.

CREATE TABLE IF NOT EXISTS customer_segments (
  customer_id bigint PRIMARY KEY,           -- Launch27 customer id
  name text,
  email text,
  phone text,
  city text,
  segment text NOT NULL,                    -- recurring | risk | repeat | first | lapsedRec | lapsedOne
  traits text[] NOT NULL DEFAULT '{}',      -- prepaid, newplan, converted, vip, cancelled
  since date NOT NULL,                      -- when they entered this segment
  ever_plan boolean NOT NULL DEFAULT false, -- has ever had a non-one-time booking
  plan text,                                -- frequency of the next (or last) booking
  last_clean date,
  next_clean date,
  last_prepaid date,                        -- last prepaid visit on the schedule
  first_plan date,
  spend_12m numeric(12,2) NOT NULL DEFAULT 0,
  cleans_12m integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_segments_segment ON customer_segments (segment);

CREATE TABLE IF NOT EXISTS segment_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL,
  from_segment text NOT NULL,               -- 'new' for a customer's first appearance
  to_segment text NOT NULL,
  changed_on date NOT NULL,
  estimated boolean NOT NULL DEFAULT false, -- rebuilt from booking history (before go-live)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS segment_changes_day ON segment_changes (changed_on);
CREATE INDEX IF NOT EXISTS segment_changes_customer ON segment_changes (customer_id, changed_on);

CREATE TABLE IF NOT EXISTS segment_daily (
  day date NOT NULL,
  segment text NOT NULL,
  customers integer NOT NULL,
  revenue_12m numeric(14,2) NOT NULL DEFAULT 0,
  estimated boolean NOT NULL DEFAULT false,
  PRIMARY KEY (day, segment)
);

CREATE TABLE IF NOT EXISTS segment_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger text NOT NULL,                    -- nightly | manual | boot
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',   -- running | done | failed
  bookings integer,
  customers integer,
  changes integer,
  error text
);

-- What staff did about a customer in a segment (call outcomes, snoozes).
CREATE TABLE IF NOT EXISTS segment_outcomes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL,
  segment text NOT NULL,
  outcome text NOT NULL,                    -- rebooked | pause | price | quality | cleaner | moved | no_answer | other | snoozed
  note text,
  snoozed_until date,
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS segment_outcomes_customer ON segment_outcomes (customer_id, created_at DESC);
