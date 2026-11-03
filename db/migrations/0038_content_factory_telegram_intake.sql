-- Metadata only; original photo bytes use existing uploads/content-factory/originals.
ALTER TABLE content_factory_items ADD COLUMN IF NOT EXISTS origin_kind TEXT NOT NULL DEFAULT 'source'
  CHECK (origin_kind IN ('source', 'own'));
ALTER TABLE content_factory_items ADD COLUMN IF NOT EXISTS own_brief TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS content_factory_telegram_intake (
  id UUID PRIMARY KEY,
  sender_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  messages JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(messages) = 'object'),
  item_id TEXT REFERENCES content_factory_items(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  completed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sender_id, chat_id, delivery_key)
);

CREATE OR REPLACE FUNCTION content_factory_own_brief_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.own_brief IS DISTINCT FROM OLD.own_brief THEN
    IF OLD.origin_kind <> 'own' OR OLD.social_post_id IS NOT NULL OR OLD.en_social_post_id IS NOT NULL
       OR OLD.en_publish_claimed OR OLD.status NOT IN ('new', 'failed') THEN
      RAISE EXCEPTION 'Own material brief can only be set before generation or publication';
    END IF;
    NEW.ai_review := NULL; NEW.ru_approved_at := NULL; NEW.en_approved_at := NULL;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS content_factory_own_brief_guard ON content_factory_items;
CREATE TRIGGER content_factory_own_brief_guard BEFORE UPDATE ON content_factory_items
FOR EACH ROW EXECUTE FUNCTION content_factory_own_brief_guard();
