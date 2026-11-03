-- Store only ordered local filenames and errors in PostgreSQL; image bytes stay in uploads/.
ALTER TABLE content_factory_items
  ADD COLUMN IF NOT EXISTS original_image_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS original_image_error TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS copy_image_permission_confirmed BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_factory_original_image_files_array_check') THEN
    ALTER TABLE content_factory_items ADD CONSTRAINT content_factory_original_image_files_array_check
      CHECK (jsonb_typeof(original_image_files) = 'array');
  END IF;
END $$;

-- This function is used by both item transitions and the existing direct Social guard.
CREATE OR REPLACE FUNCTION content_factory_review_valid(item content_factory_items)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN item.processing_mode = 'copy' THEN
    COALESCE(item.copy_permission_confirmed
      AND item.copy_approved_at IS NOT NULL
      AND item.status IN ('ready', 'scheduled', 'failed', 'published')
      AND item.original_text <> ''
      AND item.generated_text = item.original_text
      AND item.image_filename = ''
      AND item.original_image_error = ''
      AND jsonb_array_length(item.original_image_files) = CASE WHEN item.original_image_urls = '' THEN 0 ELSE cardinality(string_to_array(item.original_image_urls, ',')) END
      AND (item.original_image_urls = '' OR item.copy_image_permission_confirmed), FALSE)
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

CREATE OR REPLACE FUNCTION content_factory_item_review_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generated_title IS DISTINCT FROM OLD.generated_title
     OR NEW.generated_text IS DISTINCT FROM OLD.generated_text
     OR NEW.image_filename IS DISTINCT FROM OLD.image_filename THEN
    NEW.ai_review := NULL;
    NEW.copy_approved_at := NULL;
  END IF;
  IF NEW.original_image_urls IS DISTINCT FROM OLD.original_image_urls
     OR NEW.original_image_files IS DISTINCT FROM OLD.original_image_files THEN
    NEW.copy_approved_at := NULL;
    NEW.copy_image_permission_confirmed := false;
  END IF;
  IF NEW.status IN ('scheduled', 'published')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT content_factory_review_valid(NEW) THEN
    RAISE EXCEPTION 'Content Factory AI review is required before publication';
  END IF;
  RETURN NEW;
END;
$$;
