-- Brands (UrbanMop Residential / UrbanMop Commercial). Each Launch27 location belongs to one
-- brand; bookings, customers, cleaners and conversations take their brand from it. Known
-- location names get a default brand in the app (web/src/brands/rules.ts); admins override
-- here. Staff have a home brand (null = both) that their screens open on.
CREATE TABLE IF NOT EXISTS brands (
  slug text PRIMARY KEY,
  name text NOT NULL,
  color text NOT NULL,
  signature text,
  position integer NOT NULL DEFAULT 0
);
INSERT INTO brands (slug, name, color, signature, position) VALUES
  ('residential', 'UrbanMop Residential', '#0B7A75', 'The UrbanMop team', 1),
  ('commercial', 'UrbanMop Commercial', '#3846A3', 'UrbanMop Commercial', 2)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS brand_locations (
  location_id bigint PRIMARY KEY,      -- Launch27 location id
  location_name text,
  brand text REFERENCES brands(slug) ON DELETE SET NULL,  -- null = deliberately no brand
  set_by bigint REFERENCES users(id) ON DELETE SET NULL,
  set_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS brand text REFERENCES brands(slug) ON DELETE SET NULL;
