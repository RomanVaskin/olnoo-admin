-- Traffic classification foundation for leads (Test Traffic v1, step A). All columns are additive, with safe defaults:
-- existing rows and existing inbound clients are unaffected, nothing reads or enforces these columns yet except the
-- classifier-written values and the (not yet used) analytics-safe reader.
--
-- Apply manually, as every migration in this repo (the deploy workflow runs none). The code is written to work BEFORE
-- and AFTER this migration: while the columns are missing the INSERT simply does not name them (see lib/lead-insert.ts),
-- so the migration can be applied before or after the deploy. Safe to re-run.
--
--   traffic_class_auto        what the automatic classifier decided: REAL | TEST | UNKNOWN (default UNKNOWN)
--   traffic_class_reason      why (default 'unclassified'); step A knows 'legacy_utm_marker' and 'unclassified'
--   traffic_class_override    a human decision: REAL | TEST, or NULL = none
--   traffic_class_override_at when the override was set (NULL when there is none)
--
-- Effective class = COALESCE(traffic_class_override, traffic_class_auto). Clearing the override (NULL) restores the
-- automatic class. Old leads are NOT promoted to REAL: they stay UNKNOWN unless they carry a known test marker.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS traffic_class_auto TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS traffic_class_reason TEXT NOT NULL DEFAULT 'unclassified';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS traffic_class_override TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS traffic_class_override_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_traffic_class_auto_check') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_traffic_class_auto_check CHECK (traffic_class_auto IN ('REAL', 'TEST', 'UNKNOWN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_traffic_class_override_check') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_traffic_class_override_check CHECK (traffic_class_override IS NULL OR traffic_class_override IN ('REAL', 'TEST'));
  END IF;
END $$;

-- Backfill: only the historical explicit DriveSet test markers (exact, trimmed, case-insensitive — the same rule as the
-- classifier). Idempotent: touches only rows still at the default, never an override.
UPDATE leads
   SET traffic_class_auto = 'TEST', traffic_class_reason = 'legacy_utm_marker'
 WHERE project_id = (SELECT id FROM projects WHERE slug = 'driveset')
   AND traffic_class_auto = 'UNKNOWN'
   AND (lower(btrim(utm_content)) = 'a2_production_test' OR lower(btrim(utm_term)) = 'test_attribution');
