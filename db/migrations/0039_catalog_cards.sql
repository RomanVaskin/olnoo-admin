-- Catalog MVP: one natural find -> up to three optional offers.
-- The original Telegram media remains owned by Content Factory; do not duplicate it.
-- Not applied automatically: migrate before deploying code that uses this table.
CREATE TABLE IF NOT EXISTS catalog_cards (
  id UUID PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content_item_id TEXT NOT NULL REFERENCES content_factory_items(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  length_cm NUMERIC(8,2) CHECK (length_cm > 0),
  diameter_cm NUMERIC(8,2) CHECK (diameter_cm > 0),
  -- One offer per type: raw material, finished object, DIY guide.
  -- Only owner-confirmed facts; no generated prices or fake stock.
  offers JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(offers) = 'object'),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, content_item_id),
  UNIQUE (project_id, slug)
);
CREATE INDEX IF NOT EXISTS catalog_cards_published_idx ON catalog_cards(project_id, published_at)
  WHERE published_at IS NOT NULL;

-- Reject accidental cross-project linkage even when the content item id is valid.
CREATE OR REPLACE FUNCTION catalog_cards_enforce_project() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM content_factory_items i
    WHERE i.id = NEW.content_item_id
      AND i.project_id = NEW.project_id
      AND i.origin_kind = 'own'
  ) THEN
    RAISE EXCEPTION 'Catalog source must be an owner-uploaded item in the same project';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS catalog_cards_project_guard ON catalog_cards;
CREATE TRIGGER catalog_cards_project_guard
BEFORE INSERT OR UPDATE OF project_id, content_item_id ON catalog_cards
FOR EACH ROW EXECUTE FUNCTION catalog_cards_enforce_project();
