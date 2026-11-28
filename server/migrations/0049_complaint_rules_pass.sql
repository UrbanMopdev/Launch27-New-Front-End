-- A rules-only pass (service.js: run with sources false) recomputes every stored case's client,
-- costs and outcome when the cost or outcome rules change, without reading any source. It is
-- labelled so it never counts as the dates having been read.
ALTER TABLE complaint_runs ADD COLUMN IF NOT EXISTS label text;   -- 'rules' | null

-- Derek's rules, Nov 28 2026: a reclean costs hours x the cleaner's wage. Travel and the lost
-- slot's margin are no longer added; the lines already stored go. (The code that adds them
-- stays, behind settings.costs.include_travel / include_lost_slot.)
DELETE FROM complaint_costs WHERE kind IN ('reclean_travel', 'reclean_lost_slot');
