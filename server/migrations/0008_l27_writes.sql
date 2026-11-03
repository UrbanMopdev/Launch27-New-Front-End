-- Every change this app sends to Launch27 (or tries to while writes are off): who, when,
-- what, and what Launch27 answered. Written by src/writes.js; read on Support settings →
-- Launch27 changes. Kept indefinitely (small rows).
CREATE TABLE IF NOT EXISTS l27_writes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_email text,
  source text NOT NULL,              -- app screens (pass-through) | planner assign
  method text NOT NULL,
  path text NOT NULL,
  booking_id bigint,
  outcome text NOT NULL,             -- done | refused (Launch27 said no) | blocked (writes off here) | failed (no answer)
  status integer,
  request jsonb,
  error text
);
CREATE INDEX IF NOT EXISTS l27_writes_at ON l27_writes (at DESC);
