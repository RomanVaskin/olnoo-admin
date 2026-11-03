-- Isolated regression fixture: run in a disposable PostgreSQL database after 0031.
BEGIN;
INSERT INTO social_posts (id, project_id, body, telegram_text) VALUES ('review-post', 1, 'Reviewed text', '');
INSERT INTO content_factory_items (id, project_id, source_id, external_id, generated_title, generated_text, image_filename, status, social_post_id)
VALUES ('review-item', 1, 'review-source', '1', 'Title', 'Reviewed text', '', 'ready', 'review-post');
INSERT INTO social_publications (id, project_id, social_post_id, platform, status)
VALUES ('review-publication', 1, 'review-post', 'telegram', 'draft');

DO $$
BEGIN
  BEGIN
    UPDATE content_factory_items SET status = 'scheduled' WHERE id = 'review-item';
    RAISE EXCEPTION 'unchecked Content Factory item was scheduled';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory AI review is required before publication' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'review-publication';
    RAISE EXCEPTION 'direct Social API path bypassed the review';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory AI review is required before publication' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE social_publications SET status = 'published' WHERE id = 'review-publication';
    RAISE EXCEPTION 'direct published status bypassed the review';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory AI review is required before publication' THEN RAISE; END IF;
  END;
END;
$$;

UPDATE content_factory_items SET ai_review = '{"status":"blocked","risk":"high","passed":false,"reviewedTitle":"Title","reviewedText":"Reviewed text","reviewedImageFilename":""}'::jsonb WHERE id = 'review-item';
DO $$
BEGIN
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'review-publication';
    RAISE EXCEPTION 'high-risk review bypassed the block';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory AI review is required before publication' THEN RAISE; END IF;
  END;
END;
$$;

UPDATE content_factory_items SET ai_review = '{"status":"passed","risk":"low","passed":true,"reviewedTitle":"Title","reviewedText":"Reviewed text","reviewedImageFilename":""}'::jsonb WHERE id = 'review-item';
UPDATE social_publications SET status = 'publishing' WHERE id = 'review-publication';
UPDATE social_publications SET status = 'draft' WHERE id = 'review-publication';
UPDATE content_factory_items SET generated_text = 'Edited after review' WHERE id = 'review-item';

DO $$
BEGIN
  IF (SELECT ai_review IS NOT NULL FROM content_factory_items WHERE id = 'review-item') THEN
    RAISE EXCEPTION 'edit did not invalidate AI review';
  END IF;
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'review-publication';
    RAISE EXCEPTION 'edited text bypassed the review';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory AI review is required before publication' THEN RAISE; END IF;
  END;
END;
$$;
ROLLBACK;
