-- Source choice is snapshotted on each newly discovered item. Existing rows stay in AI mode.
ALTER TABLE content_factory_sources
  ADD COLUMN IF NOT EXISTS processing_mode TEXT NOT NULL DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS copy_permission_confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE content_factory_items
  ADD COLUMN IF NOT EXISTS processing_mode TEXT NOT NULL DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS copy_permission_confirmed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS copy_approved_at TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_factory_source_copy_permission_check') THEN
    ALTER TABLE content_factory_sources ADD CONSTRAINT content_factory_source_copy_permission_check
      CHECK (processing_mode IN ('ai', 'copy') AND (processing_mode <> 'copy' OR (type = 'telegram' AND copy_permission_confirmed)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_factory_item_copy_mode_check') THEN
    ALTER TABLE content_factory_items ADD CONSTRAINT content_factory_item_copy_mode_check
      CHECK (processing_mode IN ('ai', 'copy'));
  END IF;
END $$;

-- The existing Content Factory and direct Social guards both call this function.
-- Only a source-snapshotted, permission-confirmed, manually approved, unedited
-- original text may bypass the AI originality/quality review.
CREATE OR REPLACE FUNCTION content_factory_review_valid(item content_factory_items)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN item.processing_mode = 'copy' THEN
    COALESCE(item.copy_permission_confirmed
      AND item.copy_approved_at IS NOT NULL
      AND item.status IN ('ready', 'scheduled', 'failed', 'published')
      AND item.original_text <> ''
      AND item.generated_text = item.original_text
      AND item.image_filename = '', FALSE)
  ELSE COALESCE(
    item.ai_review->>'status' = 'passed'
    AND item.ai_review->>'risk' IN ('low', 'medium')
    AND item.ai_review->>'passed' = 'true'
    AND item.ai_review->'quality'->>'passed' = 'true'
    AND item.ai_review->>'reviewedTitle' = item.generated_title
    AND item.ai_review->>'reviewedText' = item.generated_text
    AND item.ai_review->>'reviewedImageFilename' = item.image_filename,
    FALSE)
  END;
$$;

-- A later text change invalidates the manual approval, including direct DB edits.
CREATE OR REPLACE FUNCTION content_factory_item_review_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generated_title IS DISTINCT FROM OLD.generated_title
     OR NEW.generated_text IS DISTINCT FROM OLD.generated_text
     OR NEW.image_filename IS DISTINCT FROM OLD.image_filename THEN
    NEW.ai_review := NULL;
    NEW.copy_approved_at := NULL;
  END IF;
  IF NEW.status IN ('scheduled', 'published')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT content_factory_review_valid(NEW) THEN
    RAISE EXCEPTION 'Content Factory AI review is required before publication';
  END IF;
  RETURN NEW;
END;
$$;

-- For copy mode the outgoing Social text must equal the source exactly; the AI
-- path retains its prior whitespace-normalized comparison.
CREATE OR REPLACE FUNCTION content_factory_social_review_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  item content_factory_items%ROWTYPE;
  outgoing_text TEXT;
BEGIN
  IF NEW.status = 'publishing'
     OR (NEW.status = 'published' AND OLD.status <> 'publishing') THEN
    SELECT * INTO item FROM content_factory_items
    WHERE social_post_id = NEW.social_post_id AND project_id = NEW.project_id;
    IF FOUND THEN
      SELECT CASE WHEN item.processing_mode = 'copy' THEN COALESCE(NULLIF(telegram_text, ''), body)
                  ELSE COALESCE(NULLIF(BTRIM(telegram_text), ''), BTRIM(body)) END
      INTO outgoing_text FROM social_posts WHERE id = NEW.social_post_id AND project_id = NEW.project_id;
      IF NOT content_factory_review_valid(item)
         OR (item.processing_mode = 'copy' AND outgoing_text IS DISTINCT FROM item.original_text)
         OR (item.processing_mode <> 'copy' AND outgoing_text IS DISTINCT FROM BTRIM(item.generated_text)) THEN
        RAISE EXCEPTION 'Content Factory AI review is required before publication';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
