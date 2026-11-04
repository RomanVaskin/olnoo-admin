-- Apply once after 0040, before deploying processed-photo selection. No original files/fields are modified.
BEGIN;
ALTER TABLE content_factory_items ADD COLUMN processed_image_versions JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(processed_image_versions) = 'array');
ALTER TABLE catalog_cards ADD COLUMN photo_versions JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(photo_versions) = 'object');
COMMIT;
