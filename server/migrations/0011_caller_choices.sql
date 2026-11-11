-- Incoming calls: when one phone number belongs to several Launch27 customers (a household,
-- a landlord), the agent picks who is calling. The last pick for that number is remembered
-- and pre-selected next time (decision D-3). Production only: dev and QA save nothing.
CREATE TABLE IF NOT EXISTS caller_choices (
  phone text PRIMARY KEY,               -- normalized, e.g. +16135551234
  l27_customer_id bigint NOT NULL,
  chosen_by bigint,                     -- users.id
  chosen_at timestamptz NOT NULL DEFAULT now()
);
