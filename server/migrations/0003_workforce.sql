-- Workforce settings, modelled on Kustomer: configurable agent statuses (available,
-- away reasons such as Break or Lunch, offline), teams, per-channel capacity, per-queue
-- routing mode / hours / overflow, and workspace-wide routing policies.

-- What an agent can be. kind decides routing: only 'available' receives pushed work;
-- 'away' keeps or returns work per keeps_work; 'offline' always returns work.
CREATE TABLE IF NOT EXISTS agent_statuses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  kind text NOT NULL,                              -- available | away | offline
  color text NOT NULL DEFAULT '#6b7280',
  keeps_work boolean NOT NULL DEFAULT true,        -- away: keep assigned conversations?
  max_minutes int,                                 -- alert supervisors after this long (null = no limit)
  selectable boolean NOT NULL DEFAULT true,        -- agents can pick it themselves
  position int NOT NULL DEFAULT 0
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS status_id bigint REFERENCES agent_statuses(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_since timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_alerted_at timestamptz;
-- Max open conversations per channel at once; missing channel = workspace default.
ALTER TABLE users ADD COLUMN IF NOT EXISTS capacity jsonb NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_assigned_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

-- Time in each status, for reporting (breaks, lunch, time available).
CREATE TABLE IF NOT EXISTS agent_status_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status_id bigint REFERENCES agent_statuses(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  set_by text                                      -- self | supervisor | auto
);
CREATE INDEX IF NOT EXISTS status_log_user ON agent_status_log (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS teams (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text,
  lead_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  position int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id bigint NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);
-- A queue served by a team: every team member can receive its work.
CREATE TABLE IF NOT EXISTS queue_teams (
  queue_id bigint NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  team_id bigint NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (queue_id, team_id)
);

-- Opening hours. week: {"0": ["09:00","17:00"] | null, ...} with 0 = Sunday.
CREATE TABLE IF NOT EXISTS schedules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  time_zone text NOT NULL DEFAULT 'America/Toronto',
  week jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT false
);

ALTER TABLE queues ADD COLUMN IF NOT EXISTS routing_mode text NOT NULL DEFAULT 'least_busy';  -- least_busy | round_robin | manual
ALTER TABLE queues ADD COLUMN IF NOT EXISTS schedule_id bigint REFERENCES schedules(id);
ALTER TABLE queues ADD COLUMN IF NOT EXISTS default_sla_id bigint REFERENCES sla_policies(id);
ALTER TABLE queues ADD COLUMN IF NOT EXISTS overflow_minutes int;                 -- unassigned this long ...
ALTER TABLE queues ADD COLUMN IF NOT EXISTS overflow_queue_id bigint REFERENCES queues(id);  -- ... moves here
ALTER TABLE queues ADD COLUMN IF NOT EXISTS priority_boost int NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS overflowed_at timestamptz;

-- Workspace-wide policies, one row per key (see server/src/inbox/workforce.js for defaults).
CREATE TABLE IF NOT EXISTS workspace_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Everyone who works a queue: direct members plus members of teams that serve it.
CREATE OR REPLACE VIEW queue_agents AS
  SELECT queue_id, user_id FROM queue_members
  UNION
  SELECT qt.queue_id, tm.user_id FROM queue_teams qt JOIN team_members tm ON tm.team_id = qt.team_id;
