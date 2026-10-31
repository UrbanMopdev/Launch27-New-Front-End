-- Platform: persistent sign-in sessions (so redeploys don't sign everyone out).
-- The Launch27 bearer token is stored encrypted (AES-256-GCM, key derived from SESSION_SECRET).
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,                 -- SHA-256 of the cookie value (raw id never stored)
  user_email text NOT NULL,
  bearer_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_email);

-- messages.delivery_state may now also be 'sandbox' (recorded in a non-production
-- environment, never sent). The column is free text, so no schema change is needed.
