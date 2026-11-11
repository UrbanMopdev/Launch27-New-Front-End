-- One hold books at most once, whatever Idempotency-Keys are used (src/placement/service.js).
CREATE UNIQUE INDEX IF NOT EXISTS placement_bookings_hold ON placement_bookings (hold_id) WHERE hold_id IS NOT NULL;
