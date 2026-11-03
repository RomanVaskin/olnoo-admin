-- Run against a disposable DB after 0031–0034; rolls back its own rows.
BEGIN;
DO $$ BEGIN
  BEGIN
    INSERT INTO content_factory_sources (id, project_id, type, handle, processing_mode, copy_permission_confirmed)
    VALUES ('copy-source-unsafe', 1, 'telegram', '@partner', 'copy', false);
    RAISE EXCEPTION 'copy source without permission bypassed the check';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO content_factory_sources (id, project_id, type, handle, processing_mode, copy_permission_confirmed)
    VALUES ('copy-source-rss', 1, 'rss', 'https://example.com/feed', 'copy', true);
    RAISE EXCEPTION 'non-Telegram copy source bypassed the check';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
INSERT INTO content_factory_sources (id, project_id, type, handle, processing_mode, copy_permission_confirmed)
VALUES ('copy-source', 1, 'telegram', '@partner', 'copy', true);
INSERT INTO social_posts (id, project_id, body, telegram_text) VALUES ('copy-post', 1, 'Original! 🏠', '');
INSERT INTO content_factory_items (id, project_id, source_id, external_id, original_text, generated_text,
  processing_mode, copy_permission_confirmed, status, social_post_id)
VALUES ('copy-item', 1, 'copy-source', '1', 'Original! 🏠', 'Original! 🏠', 'copy', true, 'needs_review', 'copy-post');
UPDATE content_factory_sources SET processing_mode = 'ai', copy_permission_confirmed = false WHERE id = 'copy-source';
DO $$ BEGIN
  IF (SELECT processing_mode <> 'copy' OR NOT copy_permission_confirmed FROM content_factory_items WHERE id = 'copy-item') THEN
    RAISE EXCEPTION 'source mode switch changed the item snapshot';
  END IF;
END $$;
INSERT INTO social_publications (id, project_id, social_post_id, platform, status)
VALUES ('copy-publication', 1, 'copy-post', 'telegram', 'draft');

DO $$ BEGIN
  BEGIN
    UPDATE content_factory_items SET status = 'scheduled' WHERE id = 'copy-item';
    RAISE EXCEPTION 'unapproved copy item bypassed the block';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory AI review is required before publication' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'copy-publication';
    RAISE EXCEPTION 'unapproved copy bypassed the block';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory AI review is required before publication' THEN RAISE; END IF;
  END;
END $$;

UPDATE content_factory_items SET copy_approved_at = now() WHERE id = 'copy-item';
DO $$ BEGIN
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'copy-publication';
    RAISE EXCEPTION 'timestamp without ready status bypassed manual approval';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory AI review is required before publication' THEN RAISE; END IF;
  END;
END $$;
UPDATE content_factory_items SET copy_approved_at = now(), status = 'ready' WHERE id = 'copy-item';
UPDATE social_publications SET status = 'publishing' WHERE id = 'copy-publication';
UPDATE social_publications SET status = 'draft' WHERE id = 'copy-publication';

UPDATE content_factory_items SET copy_permission_confirmed = false WHERE id = 'copy-item';
DO $$ BEGIN
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'copy-publication';
    RAISE EXCEPTION 'copy without permission bypassed the block';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory AI review is required before publication' THEN RAISE; END IF;
  END;
END $$;
UPDATE content_factory_items SET copy_permission_confirmed = true WHERE id = 'copy-item';

UPDATE social_posts SET body = 'Modified!' WHERE id = 'copy-post';
DO $$ BEGIN
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'copy-publication';
    RAISE EXCEPTION 'modified Social text bypassed the block';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory AI review is required before publication' THEN RAISE; END IF;
  END;
END $$;
UPDATE social_posts SET body = 'Original! 🏠' WHERE id = 'copy-post';

UPDATE content_factory_items SET generated_text = 'Modified!' WHERE id = 'copy-item';
DO $$ BEGIN
  IF (SELECT copy_approved_at IS NOT NULL FROM content_factory_items WHERE id = 'copy-item') THEN
    RAISE EXCEPTION 'text edit did not clear manual approval';
  END IF;
END $$;
ROLLBACK;
