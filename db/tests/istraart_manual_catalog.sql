-- Disposable regression database ONLY. No production execution.
CREATE SCHEMA istraart_manual_regression;
SET search_path TO istraart_manual_regression;
CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT, archived_at TIMESTAMPTZ);
CREATE TABLE content_factory_items (id TEXT PRIMARY KEY, project_id INTEGER, origin_kind TEXT);
INSERT INTO projects VALUES (1,'istraart',NULL),(2,'other',NULL);
INSERT INTO content_factory_items VALUES ('owner',1,'own');
\ir ../migrations/0039_catalog_cards.sql
\ir ../migrations/0040_catalog_independent_cards.sql
INSERT INTO catalog_cards(id,project_id,content_item_id,slug,title,offers,published_at)
 VALUES ('00000000-0000-4000-8000-000000000001',1,'owner','legacy','Existing','{"raw":{}}','2026-11-04');
CREATE TEMP TABLE manual_cards_snapshot AS SELECT to_jsonb(c) data FROM catalog_cards c;
\ir ../migrations/0042_istraart_manual_catalog.sql
DO $$ BEGIN
 IF (SELECT to_jsonb(c)-'manual_media'-'manual_photo_selection' FROM catalog_cards c) <> (SELECT data FROM manual_cards_snapshot) THEN RAISE EXCEPTION 'Existing card changed'; END IF;
 IF EXISTS (SELECT 1 FROM projects WHERE istraart_style_prompt IS NOT NULL) THEN RAISE EXCEPTION 'Unexpected seed'; END IF;
 IF (SELECT manual_media FROM catalog_cards) <> '[]'::jsonb OR (SELECT manual_photo_selection FROM catalog_cards) <> '{}'::jsonb THEN RAISE EXCEPTION 'Invalid defaults'; END IF;
 BEGIN
  UPDATE projects SET istraart_style_prompt='';
  RAISE EXCEPTION 'Empty prompt accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE catalog_cards SET manual_media='{}';
  RAISE EXCEPTION 'Invalid media accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE catalog_cards SET manual_photo_selection='[]';
  RAISE EXCEPTION 'Invalid selection accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END; $$;
UPDATE projects SET istraart_style_prompt='Owner style' WHERE slug='istraart';
DO $$ BEGIN
 IF (SELECT istraart_style_prompt FROM projects WHERE slug='other') IS NOT NULL THEN RAISE EXCEPTION 'Other project modified'; END IF;
END; $$;
RESET search_path;
DROP SCHEMA istraart_manual_regression CASCADE;
SELECT 'istraart manual catalog migration regression passed' AS result;
