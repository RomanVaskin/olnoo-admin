-- Disposable test database ONLY; never run this regression fixture on production.
CREATE SCHEMA catalog_photos_regression;
SET search_path TO catalog_photos_regression;
CREATE TABLE projects (id INTEGER PRIMARY KEY);
CREATE TABLE content_factory_items (id TEXT PRIMARY KEY, project_id INTEGER, origin_kind TEXT, original_image_files JSONB, original_text TEXT);
INSERT INTO projects VALUES (1);
INSERT INTO content_factory_items VALUES ('owner', 1, 'own', '["original.png"]', 'Original source text');
\ir ../migrations/0039_catalog_cards.sql
\ir ../migrations/0040_catalog_independent_cards.sql
INSERT INTO catalog_cards(id,project_id,content_item_id,slug,title,offers,published_at)
 VALUES('00000000-0000-4000-8000-000000000001',1,'owner','legacy','Existing','{"raw":{}}','2026-11-04');
CREATE TEMP TABLE photos_source_snapshot AS SELECT to_jsonb(i) data FROM content_factory_items i;
CREATE TEMP TABLE photos_card_snapshot AS SELECT to_jsonb(c) data FROM catalog_cards c;
\ir ../migrations/0041_catalog_processed_photos.sql
DO $$ BEGIN
 IF (SELECT to_jsonb(i)-'processed_image_versions' FROM content_factory_items i) <> (SELECT data FROM photos_source_snapshot) THEN RAISE EXCEPTION 'Original changed'; END IF;
 IF (SELECT to_jsonb(c)-'photo_versions' FROM catalog_cards c) <> (SELECT data FROM photos_card_snapshot) THEN RAISE EXCEPTION 'Card changed'; END IF;
 IF (SELECT processed_image_versions FROM content_factory_items) <> '[]'::jsonb THEN RAISE EXCEPTION 'Invalid history default'; END IF;
 IF (SELECT photo_versions FROM catalog_cards) <> '{}'::jsonb THEN RAISE EXCEPTION 'Invalid selection default'; END IF;
 BEGIN
  UPDATE content_factory_items SET processed_image_versions='{}';
  RAISE EXCEPTION 'Invalid history accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE catalog_cards SET photo_versions='[]';
  RAISE EXCEPTION 'Invalid photo selection accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END; $$;
UPDATE content_factory_items SET processed_image_versions=processed_image_versions || '[{"id":"first-version"}]'::jsonb;
UPDATE content_factory_items SET processed_image_versions=processed_image_versions || '[{"id":"second-version"}]'::jsonb;
DO $$ BEGIN
 IF (SELECT jsonb_array_length(processed_image_versions) FROM content_factory_items) <> 2 THEN RAISE EXCEPTION 'History overwritten'; END IF;
 IF (SELECT original_text FROM content_factory_items) <> 'Original source text' THEN RAISE EXCEPTION 'Text modified'; END IF;
 IF (SELECT original_image_files FROM content_factory_items) <> '["original.png"]'::jsonb THEN RAISE EXCEPTION 'Original reference modified'; END IF;
END; $$;
RESET search_path;
DROP SCHEMA catalog_photos_regression CASCADE;
SELECT 'catalog processed photos migration regression passed' AS result;
