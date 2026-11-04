-- Apply once after 0039, BEFORE deploying the independent-card editor/API.
-- Existing rows remain legacy cards with their UUIDs, offers and publication intact.
BEGIN;
ALTER TABLE catalog_cards
  ADD COLUMN card_kind TEXT NOT NULL DEFAULT 'legacy'
    CHECK (card_kind IN ('legacy', 'raw', 'finished', 'guide')),
  ADD COLUMN parent_card_id UUID REFERENCES catalog_cards(id) ON DELETE RESTRICT,
  ADD CONSTRAINT catalog_cards_parent_kind_check CHECK (
    (card_kind = 'guide' AND parent_card_id IS NOT NULL)
    OR (card_kind <> 'guide' AND parent_card_id IS NULL)
  ),
  ADD CONSTRAINT catalog_cards_single_offer_check CHECK (
    card_kind = 'legacy' OR offers = '{}'::jsonb
    OR (offers ? card_kind AND offers - card_kind = '{}'::jsonb)
  );
ALTER TABLE catalog_cards DROP CONSTRAINT catalog_cards_project_id_content_item_id_key;
-- Old API clients can still create at most one legacy card per source.
CREATE UNIQUE INDEX catalog_cards_legacy_source_idx
  ON catalog_cards(project_id, content_item_id) WHERE card_kind = 'legacy';
CREATE INDEX catalog_cards_source_idx ON catalog_cards(project_id, content_item_id);
CREATE INDEX catalog_cards_parent_idx ON catalog_cards(parent_card_id) WHERE parent_card_id IS NOT NULL;

CREATE OR REPLACE FUNCTION catalog_cards_enforce_project() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.content_item_id IS DISTINCT FROM OLD.content_item_id
       OR NEW.card_kind IS DISTINCT FROM OLD.card_kind
       OR NEW.parent_card_id IS DISTINCT FROM OLD.parent_card_id THEN
      RAISE EXCEPTION 'Catalog identity and source links are immutable';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM content_factory_items i
    WHERE i.id = NEW.content_item_id AND i.project_id = NEW.project_id AND i.origin_kind = 'own'
  ) THEN
    RAISE EXCEPTION 'Catalog source must be an owner-uploaded item in the same project';
  END IF;
  IF NEW.parent_card_id IS NOT NULL THEN
    PERFORM 1 FROM catalog_cards p
      WHERE p.id = NEW.parent_card_id AND p.project_id = NEW.project_id
        AND p.content_item_id = NEW.content_item_id AND p.card_kind = 'finished'
      FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A guide must reference a finished card from the same project and source';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER catalog_cards_project_guard ON catalog_cards;
CREATE TRIGGER catalog_cards_project_guard BEFORE INSERT OR UPDATE ON catalog_cards
  FOR EACH ROW EXECUTE FUNCTION catalog_cards_enforce_project();
COMMIT;
