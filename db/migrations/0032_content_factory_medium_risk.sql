-- Align the existing PostgreSQL publication guards with Content Factory's reviewed
-- risk policy: low/medium may publish, high/unchecked/stale remain blocked.
-- The two existing triggers call this function, so no trigger replacement is needed.
CREATE OR REPLACE FUNCTION content_factory_review_valid(item content_factory_items)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    item.ai_review->>'status' = 'passed'
    AND item.ai_review->>'risk' IN ('low', 'medium')
    AND item.ai_review->>'passed' = 'true'
    AND item.ai_review->>'reviewedTitle' = item.generated_title
    AND item.ai_review->>'reviewedText' = item.generated_text
    AND item.ai_review->>'reviewedImageFilename' = item.image_filename,
    FALSE
  );
$$;
