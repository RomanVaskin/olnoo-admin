-- Existing JSONB stores the separate editorial-quality decision. Require it in the same
-- database guard used by Content Factory and direct Social publication paths.
-- Apply before deploying the reviewer that writes quality; old reviews remain unchecked.
CREATE OR REPLACE FUNCTION content_factory_review_valid(item content_factory_items)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    item.ai_review->>'status' = 'passed'
    AND item.ai_review->>'risk' IN ('low', 'medium')
    AND item.ai_review->>'passed' = 'true'
    AND item.ai_review->'quality'->>'passed' = 'true'
    AND item.ai_review->>'reviewedTitle' = item.generated_title
    AND item.ai_review->>'reviewedText' = item.generated_text
    AND item.ai_review->>'reviewedImageFilename' = item.image_filename,
    FALSE
  );
$$;
