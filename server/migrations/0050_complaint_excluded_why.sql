-- Why a case is left out of the playbook when a rule (not a person) excluded it: a system
-- notice that is not a client's message (hints.js systemNotice). NULL for cases a person
-- marked "not a complaint". client_match gains 'message': the client was named inside a
-- message a system sent (Reply-To, an address or phone in the text, a booking number).
ALTER TABLE complaint_cases ADD COLUMN IF NOT EXISTS excluded_why text;
