-- Launch27 locations each customer has booked, so customer lists and counts can follow the
-- brand switcher (a customer of both brands shows in both). Filled by the segment sync.
ALTER TABLE customer_segments ADD COLUMN IF NOT EXISTS location_ids bigint[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS customer_segments_locations ON customer_segments USING gin (location_ids);
