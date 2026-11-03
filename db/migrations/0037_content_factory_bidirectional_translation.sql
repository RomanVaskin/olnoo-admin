-- The prepared text keeps its detected native language; only the other language is translated.
ALTER TABLE content_factory_items
  ADD COLUMN IF NOT EXISTS source_language TEXT CHECK (source_language IN ('ru', 'en')),
  ADD COLUMN IF NOT EXISTS ru_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ru_source_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ru_rights_confirmed BOOLEAN NOT NULL DEFAULT false;

-- Preserve all previously linked/published RU posts. Classify only unlinked drafts.
WITH counts AS (
  SELECT id,
    length(regexp_replace(regexp_replace(generated_text, 'https?://[^[:space:]]+', '', 'g'), '[^A-Za-z]', '', 'g')) AS latin,
    length(regexp_replace(regexp_replace(generated_text, 'https?://[^[:space:]]+', '', 'g'), '[^А-Яа-яЁё]', '', 'g')) AS cyrillic
  FROM content_factory_items
  WHERE source_language IS NULL AND generated_text <> '' AND social_post_id IS NULL AND en_social_post_id IS NULL
)
UPDATE content_factory_items item SET source_language = CASE
  WHEN counts.latin >= 5 AND counts.latin > counts.cyrillic * 1.5 THEN 'en'
  WHEN counts.cyrillic >= 5 AND counts.cyrillic > counts.latin * 1.5 THEN 'ru'
  ELSE NULL END
FROM counts WHERE item.id = counts.id;
UPDATE content_factory_items SET source_language = 'ru'
WHERE source_language IS NULL AND (social_post_id IS NOT NULL OR en_social_post_id IS NOT NULL);

CREATE OR REPLACE FUNCTION content_factory_item_review_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generated_title IS DISTINCT FROM OLD.generated_title
     OR NEW.generated_text IS DISTINCT FROM OLD.generated_text
     OR NEW.source_language IS DISTINCT FROM OLD.source_language
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
     OR NEW.en_account_id IS DISTINCT FROM OLD.en_account_id THEN NEW.en_approved_at := NULL; END IF;
  IF NEW.ru_text IS DISTINCT FROM OLD.ru_text
     OR NEW.ru_source_text IS DISTINCT FROM OLD.ru_source_text
     OR NEW.ru_account_id IS DISTINCT FROM OLD.ru_account_id THEN NEW.ru_approved_at := NULL; END IF;
  IF NEW.status IN ('scheduled', 'published')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT content_factory_review_valid(NEW) THEN
    RAISE EXCEPTION 'Content Factory review is required before publication';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION content_factory_social_review_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  item content_factory_items%ROWTYPE;
  outgoing_text TEXT;
  expected_text TEXT;
  translated BOOLEAN;
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
      translated := (item.en_social_post_id = NEW.social_post_id AND item.source_language = 'ru')
                 OR (item.social_post_id = NEW.social_post_id AND item.source_language = 'en');
      expected_text := CASE
        WHEN item.en_social_post_id = NEW.social_post_id THEN
          CASE WHEN translated THEN item.en_text ELSE item.generated_text END
        ELSE CASE WHEN translated THEN item.ru_text ELSE item.generated_text END END;
      IF item.source_language IS NULL OR expected_text = ''
         OR (item.processing_mode = 'copy' AND outgoing_text IS DISTINCT FROM expected_text)
         OR (item.processing_mode <> 'copy' AND BTRIM(outgoing_text) IS DISTINCT FROM BTRIM(expected_text))
         OR (item.processing_mode = 'copy' AND NOT (
           item.copy_permission_confirmed AND item.copy_approved_at IS NOT NULL
           AND (item.original_image_urls = '' OR item.copy_image_permission_confirmed)
           AND item.original_text <> ''
           AND item.generated_text = item.original_text AND item.image_filename = ''
           AND item.original_image_error = ''
           AND jsonb_array_length(item.original_image_files) = CASE WHEN item.original_image_urls = '' THEN 0 ELSE cardinality(string_to_array(item.original_image_urls, ',')) END))
         OR (item.processing_mode <> 'copy' AND NOT COALESCE(
           item.ai_review->>'status' = 'passed' AND item.ai_review->>'risk' IN ('low', 'medium')
           AND item.ai_review->>'passed' = 'true' AND item.ai_review->'quality'->>'passed' = 'true'
           AND item.ai_review->>'reviewedTitle' = item.generated_title
           AND item.ai_review->>'reviewedText' = item.generated_text
           AND item.ai_review->>'reviewedImageFilename' = item.image_filename, false)) THEN
        RAISE EXCEPTION 'Content Factory source review or outgoing text is invalid';
      END IF;
      IF item.en_social_post_id = NEW.social_post_id THEN
        IF item.en_approved_at IS NULL OR item.en_account_id IS DISTINCT FROM NEW.social_account_id
           OR (translated AND (item.en_source_text IS DISTINCT FROM item.generated_text
             OR (item.processing_mode = 'copy' AND NOT item.en_rights_confirmed)))
           OR (NOT translated AND NOT content_factory_review_valid(item)) THEN
          RAISE EXCEPTION 'Content Factory EN approval is required before publication';
        END IF;
      ELSE
        IF item.ru_approved_at IS NULL OR item.ru_account_id IS DISTINCT FROM NEW.social_account_id
           OR (translated AND (item.ru_source_text IS DISTINCT FROM item.generated_text
             OR (item.processing_mode = 'copy' AND NOT item.ru_rights_confirmed)))
           OR (NOT translated AND NOT content_factory_review_valid(item)) THEN
          RAISE EXCEPTION 'Content Factory RU approval is required before publication';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
