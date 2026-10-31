-- Support workspace schema, v1.
-- Launch27 stays the record for bookings, customers, cleaners and money. These tables
-- hold what Launch27 doesn't: people's channel identities, conversations, notes,
-- routing, SLAs and the audit trail.

CREATE TABLE IF NOT EXISTS users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  role text NOT NULL DEFAULT 'agent',            -- agent | supervisor | admin
  presence text NOT NULL DEFAULT 'offline',      -- available | busy | offline
  presence_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queues (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  restricted boolean NOT NULL DEFAULT false,      -- only members (and admins) can see it
  position int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS queue_members (
  queue_id bigint NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (queue_id, user_id)
);

-- A person. Roles say which panel, routing and SLA apply: customer, cleaner, applicant, system.
CREATE TABLE IF NOT EXISTS contacts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text,
  roles jsonb NOT NULL DEFAULT '[]',
  brand text NOT NULL DEFAULT 'urbanmop',
  l27_customer_id bigint,
  l27_team_id bigint,
  lead_stage text,
  lead_source text,
  communication_preference text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_l27_customer ON contacts (l27_customer_id);
CREATE INDEX IF NOT EXISTS contacts_l27_team ON contacts (l27_team_id);

-- Emails and phone numbers, normalized (lower-case email, E.164 phone).
-- The same value may belong to several contacts (a shared family phone): matching then
-- flags the conversation instead of guessing.
CREATE TABLE IF NOT EXISTS contact_identities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,                             -- email | phone
  value text NOT NULL,
  label text,
  opted_out boolean NOT NULL DEFAULT false,
  opted_out_at timestamptz,
  UNIQUE (contact_id, kind, value)
);
CREATE INDEX IF NOT EXISTS identities_lookup ON contact_identities (kind, value);

CREATE TABLE IF NOT EXISTS sla_policies (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  first_response_minutes int NOT NULL,
  business_hours boolean NOT NULL DEFAULT true,
  warn_minutes int NOT NULL DEFAULT 2
);

-- Ordered, first match wins. conditions/action are JSON; see routing.js.
CREATE TABLE IF NOT EXISTS routing_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  position int NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  conditions jsonb NOT NULL DEFAULT '{}',
  action jsonb NOT NULL DEFAULT '{}',
  replaces text
);

CREATE TABLE IF NOT EXISTS conversations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id bigint REFERENCES contacts(id),
  needs_match boolean NOT NULL DEFAULT false,     -- identity matched several contacts, or none
  brand text NOT NULL DEFAULT 'urbanmop',
  channel text NOT NULL,                          -- email | sms | voice | chat
  our_identity text,                              -- the UrbanMop address or number it came to
  their_identity text,                            -- the customer's address or number
  subject text,
  thread_key text,                                -- provider thread id (email)
  status text NOT NULL DEFAULT 'open',            -- open | snoozed | done
  snooze_until timestamptz,
  queue_id bigint REFERENCES queues(id),
  owner_id bigint REFERENCES users(id),
  priority int NOT NULL DEFAULT 3,                -- 1 lowest .. 5 highest
  sla_policy_id bigint REFERENCES sla_policies(id),
  sla_due_at timestamptz,
  sla_breached_at timestamptz,
  sla_warned_at timestamptz,
  awaiting_reply_since timestamptz,
  first_response_at timestamptz,
  l27_booking_id bigint,
  disposition jsonb,
  complaint jsonb,
  routed_by text,
  reopened_count int NOT NULL DEFAULT 0,
  done_at timestamptz,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  last_preview text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conv_contact ON conversations (contact_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conv_work ON conversations (status, queue_id, owner_id);
CREATE INDEX IF NOT EXISTS conv_thread ON conversations (channel, thread_key);
CREATE INDEX IF NOT EXISTS conv_booking ON conversations (l27_booking_id);

-- Everything on a conversation's timeline: messages, internal notes, calls, system events.
CREATE TABLE IF NOT EXISTS messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind text NOT NULL,                             -- message | note | call | event
  direction text,                                 -- in | out (messages and calls)
  channel text,
  from_addr text,
  to_addr text,
  subject text,
  body text,
  author_id bigint REFERENCES users(id),
  delivery_state text,                            -- received | queued | sent | delivered | failed | not_connected
  external_id text UNIQUE,                        -- provider id, for idempotent ingest
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS msg_conv ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS canned_responses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortcut text NOT NULL UNIQUE,
  title text NOT NULL,
  body text NOT NULL,
  channels jsonb NOT NULL DEFAULT '[]'            -- empty = any channel
);

CREATE TABLE IF NOT EXISTS holidays (
  day date PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,                             -- assigned | mention | reply | sla_warning | sla_breach
  conversation_id bigint REFERENCES conversations(id) ON DELETE CASCADE,
  text text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_user ON notifications (user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id bigint REFERENCES users(id),
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_object ON audit_log (object_type, object_id, created_at DESC);
