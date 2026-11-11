-- Placement API (src/placement/, docs/placement.md): the Sales Hub quotes, holds and books
-- through this app so UrbanMop's own scheduling rules apply. Launch27 stays the record of the
-- booking itself; these tables only carry a booking attempt from quote to Launch27.
-- Quotes (with the address) and finished attempts are deleted after 30 days.

CREATE TABLE IF NOT EXISTS placement_quotes (
  id text PRIMARY KEY,
  caller text NOT NULL,              -- which service token asked (e.g. sales-hub)
  brand text NOT NULL,               -- brand slug (residential)
  location_id bigint NOT NULL,       -- Launch27 location the address falls in
  request jsonb NOT NULL,            -- the QuoteRequest, address included
  data jsonb NOT NULL,               -- what booking needs: frequency, Launch27 service line, duration, price
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS placement_quotes_created ON placement_quotes (created_at);

-- Holds: a slot set aside for a few minutes while the rep finishes. Launch27 can't reserve a
-- time, so holds live here and are treated as busy by this app's availability.
CREATE TABLE IF NOT EXISTS placement_holds (
  id text PRIMARY KEY,
  quote_id text NOT NULL REFERENCES placement_quotes(id) ON DELETE CASCADE,
  cleaner_id bigint NOT NULL,
  day date NOT NULL,
  start_min integer NOT NULL,        -- minutes after midnight, Toronto time
  end_min integer NOT NULL,
  slot jsonb NOT NULL,               -- the contract Slot that was held
  lead_ref text,
  placed_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  used_at timestamptz,
  booking_id bigint
);
CREATE INDEX IF NOT EXISTS placement_holds_open ON placement_holds (cleaner_id, day) WHERE released_at IS NULL AND used_at IS NULL;

-- One row per Idempotency-Key: a retried booking returns the first answer instead of booking twice.
CREATE TABLE IF NOT EXISTS placement_bookings (
  key text PRIMARY KEY,              -- caller + ':' + Idempotency-Key
  fingerprint text NOT NULL,         -- SHA-256 of the request body
  hold_id text,
  state text NOT NULL CHECK (state IN ('pending', 'done', 'unknown')),
  status integer,
  response jsonb,
  booking_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS placement_bookings_created ON placement_bookings (created_at);
