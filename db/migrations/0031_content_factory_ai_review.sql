-- Apply manually before deploying the Admin code that reads ai_review.
-- No existing Content Factory item is grandfathered in: null means unchecked.
ALTER TABLE content_factory_items ADD COLUMN IF NOT EXISTS ai_review JSONB;

CREATE OR REPLACE FUNCTION content_factory_review_valid(item content_factory_items)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    item.ai_review->>'status' = 'passed'
    AND item.ai_review->>'risk' = 'low'
    AND item.ai_review->>'passed' = 'true'
    AND item.ai_review->>'reviewedTitle' = item.generated_title
    AND item.ai_review->>'reviewedText' = item.generated_text
    AND item.ai_review->>'reviewedImageFilename' = item.image_filename,
    FALSE
  );
$$;

CREATE OR REPLACE FUNCTION content_factory_item_review_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generated_title IS DISTINCT FROM OLD.generated_title
     OR NEW.generated_text IS DISTINCT FROM OLD.generated_text
     OR NEW.image_filename IS DISTINCT FROM OLD.image_filename THEN
    NEW.ai_review := NULL;
  END IF;
  IF NEW.status IN ('scheduled', 'published')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT content_factory_review_valid(NEW) THEN
    RAISE EXCEPTION 'Content Factory AI review is required before publication';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS content_factory_item_review_guard_trigger ON content_factory_items;
CREATE TRIGGER content_factory_item_review_guard_trigger
BEFORE UPDATE ON content_factory_items
FOR EACH ROW EXECUTE FUNCTION content_factory_item_review_guard();

-- The existing Social API can publish a linked post directly. Guard its atomic claim so all
-- routes, including Social's manual/scheduler routes, obey the same Content Factory decision.
-- The publisher reads outgoing text before this claim. A later edit cannot alter that send.
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
      SELECT COALESCE(NULLIF(BTRIM(telegram_text), ''), BTRIM(body)) INTO outgoing_text
      FROM social_posts WHERE id = NEW.social_post_id AND project_id = NEW.project_id;
      IF NOT content_factory_review_valid(item)
         OR outgoing_text IS DISTINCT FROM BTRIM(item.generated_text) THEN
        RAISE EXCEPTION 'Content Factory AI review is required before publication';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS content_factory_social_review_guard_trigger ON social_publications;
CREATE TRIGGER content_factory_social_review_guard_trigger
BEFORE UPDATE ON social_publications
FOR EACH ROW EXECUTE FUNCTION content_factory_social_review_guard();
