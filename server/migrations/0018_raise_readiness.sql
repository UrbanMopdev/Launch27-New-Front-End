-- Raise readiness on cleaner reports (src/reports/raise.js).

-- Every time a cleaner is taken off an assigned visit: from Dispatch (with the reason picked
-- there) or found by the planner's sync when it changed in Launch27 (reason picked on the
-- Changes card). Only cleaner-initiated reasons count against the cleaner.
CREATE TABLE IF NOT EXISTS cleaner_drops (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cleaner_id bigint NOT NULL,
  visit_key text NOT NULL,           -- the planner's visit key (the booking id for real bookings)
  booking_id bigint,
  customer text,
  visit_at timestamptz NOT NULL,     -- when the visit was due to start
  dropped_at timestamptz NOT NULL,   -- when the cleaner came off it (or when the sync noticed)
  reason text,                       -- cleaner_sick | cleaner_personal | cleaner_no_show | client_cancelled | office_reschedule | weather
  source text NOT NULL,              -- dispatch | sync
  change_id bigint REFERENCES schedule_changes(id) ON DELETE SET NULL,
  coded_by bigint REFERENCES users(id) ON DELETE SET NULL,
  coded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (visit_key, cleaner_id)
);
CREATE INDEX IF NOT EXISTS cleaner_drops_cleaner ON cleaner_drops (cleaner_id, dropped_at DESC);

-- Google reviews that name a cleaner (phase 1: typed in on the cleaner's report). Also the
-- record of the $10 review bonus.
CREATE TABLE IF NOT EXISTS cleaner_google_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cleaner_id bigint NOT NULL,
  review_date date NOT NULL,
  reviewer text NOT NULL,
  link text,
  bonus_paid boolean NOT NULL DEFAULT false,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cleaner_google_reviews_cleaner ON cleaner_google_reviews (cleaner_id, review_date DESC);

-- Inbox: which cleaner a conversation is about (feeds complaint counts on cleaner reports).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS cleaner_id bigint;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS cleaner_name text;
CREATE INDEX IF NOT EXISTS conversations_cleaner ON conversations (cleaner_id) WHERE cleaner_id IS NOT NULL;
