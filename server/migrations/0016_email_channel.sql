-- Email channel (Gmail). Each connected mailbox keeps its read position here, so inbound
-- sync resumes after a restart, and Support settings can show whether it is healthy.
CREATE TABLE IF NOT EXISTS channel_accounts (
  channel text NOT NULL,                          -- email
  address text NOT NULL,                          -- the mailbox we read (info@urbanmop.ca)
  provider text NOT NULL,                         -- gmail
  cursor text,                                    -- Gmail history id read up to
  last_poll_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  ingested_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, address)
);

-- Email threading by Message-ID: a customer's reply names the message it answers
-- (In-Reply-To / References), which joins it to the right conversation.
CREATE INDEX IF NOT EXISTS msg_message_id ON messages ((meta->>'message_id')) WHERE channel = 'email';
