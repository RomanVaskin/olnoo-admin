-- Run against a disposable DB after migration 0035; rolls back its own rows.
BEGIN;
INSERT INTO content_factory_sources (id, project_id, type, handle, processing_mode, copy_permission_confirmed)
VALUES ('copy-image-source', 1, 'telegram', '@partner', 'copy', true);
INSERT INTO social_posts (id, project_id, body, telegram_text) VALUES ('copy-image-post', 1, 'Original', '');
INSERT INTO content_factory_items (id, project_id, source_id, external_id, original_text, generated_text,
  original_image_urls, processing_mode, copy_permission_confirmed, copy_approved_at, status, social_post_id)
VALUES ('copy-image-item', 1, 'copy-image-source', '1', 'Original', 'Original',
  'https://cdn4.telesco.pe/file/1.jpg,https://cdn4.telesco.pe/file/2.jpg', 'copy', true, now(), 'ready', 'copy-image-post');

DO $$ BEGIN
  IF (SELECT content_factory_review_valid(i) FROM content_factory_items i WHERE id = 'copy-image-item') THEN
    RAISE EXCEPTION 'incomplete album passed the publication guard';
  END IF;
END $$;
UPDATE content_factory_items SET original_image_files = '["one.jpg", "two.jpg"]'::jsonb WHERE id = 'copy-image-item';
DO $$ BEGIN
  IF (SELECT copy_approved_at IS NOT NULL FROM content_factory_items WHERE id = 'copy-image-item') THEN
    RAISE EXCEPTION 'new image files did not invalidate earlier manual approval';
  END IF;
END $$;
UPDATE content_factory_items SET copy_approved_at = now() WHERE id = 'copy-image-item';
DO $$ BEGIN
  IF (SELECT content_factory_review_valid(i) FROM content_factory_items i WHERE id = 'copy-image-item') THEN
    RAISE EXCEPTION 'album without image rights passed the publication guard';
  END IF;
END $$;
UPDATE content_factory_items SET copy_image_permission_confirmed = true WHERE id = 'copy-image-item';
DO $$ BEGIN
  IF NOT (SELECT content_factory_review_valid(i) FROM content_factory_items i WHERE id = 'copy-image-item') THEN
    RAISE EXCEPTION 'complete, permitted album was blocked';
  END IF;
END $$;
UPDATE content_factory_items SET original_image_error = 'download failed' WHERE id = 'copy-image-item';
DO $$ BEGIN
  IF (SELECT content_factory_review_valid(i) FROM content_factory_items i WHERE id = 'copy-image-item') THEN
    RAISE EXCEPTION 'album with a download error passed the publication guard';
  END IF;
END $$;
ROLLBACK;
