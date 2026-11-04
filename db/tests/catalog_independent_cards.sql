-- REGRESSION FIXTURE ONLY. Run with psql -v ON_ERROR_STOP=1 on a DISPOSABLE database.
-- Separate schema; never run this fixture on production.
CREATE SCHEMA catalog_cards_regression;
SET search_path TO catalog_cards_regression;
CREATE TABLE projects (id INTEGER PRIMARY KEY);
CREATE TABLE content_factory_items (id TEXT PRIMARY KEY, project_id INTEGER, origin_kind TEXT);
INSERT INTO projects VALUES (1), (2);
INSERT INTO content_factory_items VALUES ('own-a',1,'own'), ('own-b',1,'own'), ('foreign',2,'own'), ('collected',1,'source');
\ir ../migrations/0039_catalog_cards.sql
INSERT INTO catalog_cards (id,project_id,content_item_id,slug,title,offers,published_at)
VALUES ('00000000-0000-4000-8000-000000000001',1,'own-a','legacy','Existing published card',
 '{"raw":{"title":"Raw","description":"Existing description","priceRub":1500,"available":true,"imageIndexes":[0]}}', '2026-11-04T00:00:00Z');
CREATE TEMP TABLE legacy_snapshot AS SELECT to_jsonb(c) AS data FROM catalog_cards c;
\ir ../migrations/0040_catalog_independent_cards.sql

CREATE FUNCTION expect_rejected(statement TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN RETURN;
  END;
  RAISE EXCEPTION 'Expected rejection: %', statement;
END; $$;

INSERT INTO catalog_cards (id,project_id,content_item_id,slug,title,card_kind) VALUES
 ('00000000-0000-4000-8000-000000000002',1,'own-a','lamp','Lamp','finished'),
 ('00000000-0000-4000-8000-000000000003',1,'own-a','sculpture','Sculpture','finished'),
 ('00000000-0000-4000-8000-000000000004',1,'own-a','raw','Raw','raw'),
 ('00000000-0000-4000-8000-000000000005',1,'own-b','other-source','Other source','finished'),
 ('00000000-0000-4000-8000-000000000006',2,'foreign','foreign','Foreign','finished');
INSERT INTO catalog_cards (id,project_id,content_item_id,slug,title,card_kind,parent_card_id) VALUES
 ('00000000-0000-4000-8000-000000000007',1,'own-a','lamp-guide','Lamp guide','guide','00000000-0000-4000-8000-000000000002');
DO $$ BEGIN
 IF (SELECT to_jsonb(c) - 'card_kind' - 'parent_card_id' FROM catalog_cards c WHERE slug='legacy') <> (SELECT data FROM legacy_snapshot) THEN
   RAISE EXCEPTION 'Legacy card changed';
 END IF;
 IF (SELECT count(*) FROM catalog_cards WHERE content_item_id='own-a' AND card_kind='finished') <> 2 THEN
   RAISE EXCEPTION 'Multiple finished cards missing';
 END IF;
 IF EXISTS (SELECT 1 FROM catalog_cards WHERE card_kind <> 'legacy' AND published_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Creation must not approve or publish';
 END IF;
END; $$;

SELECT expect_rejected($q$INSERT INTO catalog_cards(id,project_id,content_item_id,slug,title,card_kind,parent_card_id) VALUES('00000000-0000-4000-8000-000000000010',1,'own-a','bad-guide','Bad','guide','00000000-0000-4000-8000-000000000006')$q$);
SELECT expect_rejected($q$INSERT INTO catalog_cards(id,project_id,content_item_id,slug,title,card_kind,parent_card_id) VALUES('00000000-0000-4000-8000-000000000010',1,'own-a','bad-guide','Bad','guide','00000000-0000-4000-8000-000000000005')$q$);
SELECT expect_rejected($q$INSERT INTO catalog_cards(id,project_id,content_item_id,slug,title,card_kind,parent_card_id) VALUES('00000000-0000-4000-8000-000000000010',1,'own-a','bad-guide','Bad','guide','00000000-0000-4000-8000-000000000004')$q$);
SELECT expect_rejected($q$INSERT INTO catalog_cards(id,project_id,content_item_id,slug,title,card_kind) VALUES('00000000-0000-4000-8000-000000000010',1,'own-a','missing-parent','Bad','guide')$q$);
SELECT expect_rejected($q$INSERT INTO catalog_cards(id,project_id,content_item_id,slug,title,card_kind) VALUES('00000000-0000-4000-8000-000000000010',1,'foreign','wrong-project','Bad','finished')$q$);
SELECT expect_rejected($q$INSERT INTO catalog_cards(id,project_id,content_item_id,slug,title,card_kind) VALUES('00000000-0000-4000-8000-000000000010',1,'collected','not-own','Bad','finished')$q$);
SELECT expect_rejected($q$INSERT INTO catalog_cards(id,project_id,content_item_id,slug,title) VALUES('00000000-0000-4000-8000-000000000010',1,'own-a','second-legacy','Bad')$q$);
SELECT expect_rejected($q$INSERT INTO catalog_cards(id,project_id,content_item_id,slug,title,card_kind) VALUES('00000000-0000-4000-8000-000000000010',1,'own-a','lamp','Bad','finished')$q$);
SELECT expect_rejected($q$UPDATE catalog_cards SET offers='{"raw":{}}' WHERE slug='lamp'$q$);
SELECT expect_rejected($q$UPDATE catalog_cards SET content_item_id='own-b' WHERE slug='lamp'$q$);
SELECT expect_rejected($q$UPDATE catalog_cards SET card_kind='raw' WHERE slug='lamp'$q$);
SELECT expect_rejected($q$UPDATE catalog_cards SET parent_card_id='00000000-0000-4000-8000-000000000003' WHERE slug='lamp-guide'$q$);
SELECT expect_rejected($q$DELETE FROM catalog_cards WHERE slug='lamp'$q$);

UPDATE catalog_cards SET published_at=now() WHERE slug='lamp';
DO $$ BEGIN
 IF (SELECT count(*) FROM catalog_cards WHERE card_kind <> 'legacy' AND published_at IS NOT NULL) <> 1 THEN
   RAISE EXCEPTION 'Publication changed another card';
 END IF;
END; $$;
UPDATE catalog_cards SET published_at=NULL WHERE slug='lamp';
RESET search_path;
DROP SCHEMA catalog_cards_regression CASCADE;
SELECT 'catalog independent cards migration regression passed' AS result;
