-- Incoming calls (U-4): a number marked as spam or a wrong number. The call card warns on
-- the next call, and these contacts stay out of the Leads / Applicants / Other lists.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS caller_flag text CHECK (caller_flag IN ('spam', 'wrong_number'));
