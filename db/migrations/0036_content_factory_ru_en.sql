-- One Content Factory item may have independent RU and EN Social posts. Social publications
-- remain the source of truth for delivery status and retain their atomic send claim.
ALTER TABLE content_factory_items
  ADD COLUMN IF NOT EXISTS ru_account_id TEXT REFERENCES social_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ru_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS en_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS en_source_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS en_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS en_rights_confirmed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS en_account_id TEXT REFERENCES social_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS en_social_post_id TEXT REFERENCES social_posts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS en_publish_claimed BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS content_factory_items_en_social_post_uidx
  ON content_factory_items(en_social_post_id) WHERE en_social_post_id IS NOT NULL;

CREATE OR REPLACE FUNCTION content_factory_item_review_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generated_title IS DISTINCT FROM OLD.generated_title
     OR NEW.generated_text IS DISTINCT FROM OLD.generated_text
     OR NEW.image_filename IS DISTINCT FROM OLD.image_filename THEN
    NEW.ai_review := NULL;
    NEW.copy_approved_at := NULL;
    NEW.ru_approved_at := NULL;
    NEW.en_approved_at := NULL;
  END IF;
  IF NEW.original_image_urls IS DISTINCT FROM OLD.original_image_urls
     OR NEW.original_image_files IS DISTINCT FROM OLD.original_image_files THEN
    NEW.copy_approved_at := NULL;
    NEW.copy_image_permission_confirmed := false;
    NEW.ru_approved_at := NULL;
    NEW.en_approved_at := NULL;
  END IF;
  IF NEW.en_text IS DISTINCT FROM OLD.en_text
     OR NEW.en_source_text IS DISTINCT FROM OLD.en_source_text
     OR NEW.en_account_id IS DISTINCT FROM OLD.en_account_id THEN
    NEW.en_approved_at := NULL;
  END IF;
  IF NEW.ru_account_id IS DISTINCT FROM OLD.ru_account_id THEN NEW.ru_approved_at := NULL; END IF;
  IF NEW.status IN ('scheduled', 'published')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT content_factory_review_valid(NEW) THEN
    RAISE EXCEPTION 'Content Factory review is required before publication';
  END IF;
  RETURN NEW;
END;
$$;

-- Guard both language posts even when published through the direct Social API or scheduler.
CREATE OR REPLACE FUNCTION content_factory_social_review_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  item content_factory_items%ROWTYPE;
  outgoing_text TEXT;
BEGIN
  IF NEW.status = 'publishing' OR (NEW.status = 'published' AND OLD.status <> 'publishing') THEN
    SELECT * INTO item FROM content_factory_items
      WHERE project_id = NEW.project_id
        AND (social_post_id = NEW.social_post_id OR en_social_post_id = NEW.social_post_id);
    IF FOUND THEN
      IF NEW.platform <> 'telegram' OR NEW.social_account_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM social_accounts a WHERE a.id = NEW.social_account_id
           AND a.project_id = NEW.project_id AND a.platform = 'telegram' AND a.active AND a.status = 'connected') THEN
        RAISE EXCEPTION 'Content Factory requires a connected Telegram account in the same project';
      END IF;
      SELECT COALESCE(NULLIF(telegram_text, ''), body) INTO outgoing_text
        FROM social_posts WHERE id = NEW.social_post_id AND project_id = NEW.project_id;
      IF item.en_social_post_id = NEW.social_post_id THEN
        IF item.en_approved_at IS NULL OR item.en_account_id IS DISTINCT FROM NEW.social_account_id
           OR item.en_text = '' OR item.en_source_text IS DISTINCT FROM item.generated_text
           OR item.en_text IS DISTINCT FROM outgoing_text
           OR (item.processing_mode = 'copy' AND NOT (
             item.copy_permission_confirmed AND item.en_rights_confirmed
             AND item.original_text <> '' AND item.generated_text = item.original_text
             AND item.image_filename = '' AND item.original_image_error = ''
             AND jsonb_array_length(item.original_image_files) = CASE WHEN item.original_image_urls = '' THEN 0 ELSE cardinality(string_to_array(item.original_image_urls, ',')) END))
           OR (item.processing_mode <> 'copy' AND NOT COALESCE(
             item.ai_review->>'status' = 'passed' AND item.ai_review->>'risk' IN ('low', 'medium')
             AND item.ai_review->>'passed' = 'true' AND item.ai_review->'quality'->>'passed' = 'true'
             AND item.ai_review->>'reviewedTitle' = item.generated_title
             AND item.ai_review->>'reviewedText' = item.generated_text
             AND item.ai_review->>'reviewedImageFilename' = item.image_filename, false)) THEN
          RAISE EXCEPTION 'Content Factory EN approval and review are required before publication';
        END IF;
      ELSE
        IF item.ru_approved_at IS NULL OR item.ru_account_id IS DISTINCT FROM NEW.social_account_id
           OR NOT content_factory_review_valid(item)
           OR (item.processing_mode = 'copy' AND outgoing_text IS DISTINCT FROM item.original_text)
           OR (item.processing_mode <> 'copy' AND BTRIM(outgoing_text) IS DISTINCT FROM BTRIM(item.generated_text)) THEN
          RAISE EXCEPTION 'Content Factory RU approval and review are required before publication';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
