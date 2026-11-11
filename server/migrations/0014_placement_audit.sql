-- Placement API audit (src/placement/api.js): one row per request from the Sales Hub (or a
-- refused stranger): who, what, the result and how long it took. Never request bodies, so no
-- customer details. Kept 180 days. Admins read it in Support settings → Sales Hub API.
CREATE TABLE IF NOT EXISTS placement_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  caller text,                       -- token name; null when the token was missing or unknown
  ip text,
  method text NOT NULL,
  operation text,                    -- contract operationId (createBooking, ...)
  path text NOT NULL,
  status integer NOT NULL,
  code text,                         -- contract error code, when refused
  ms integer NOT NULL,
  ref text                           -- quote, hold or booking it concerned
);
CREATE INDEX IF NOT EXISTS placement_audit_at ON placement_audit (at);

-- One hold books at most once, whatever Idempotency-Keys are used (src/placement/service.js).
CREATE UNIQUE INDEX IF NOT EXISTS placement_bookings_hold ON placement_bookings (hold_id) WHERE hold_id IS NOT NULL;
