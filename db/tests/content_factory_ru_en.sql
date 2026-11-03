-- Run on disposable PostgreSQL after migration 0036. No Telegram calls; rolls back.
BEGIN;
INSERT INTO social_accounts (id, project_id, platform, name, username, status)
VALUES ('cf-ru-account', 1, 'telegram', 'RU', '@aurelmar', 'connected'),
       ('cf-en-account', 1, 'telegram', 'EN', '@aurelmar_en', 'connected');
INSERT INTO content_factory_sources (id, project_id, type, handle, processing_mode, copy_permission_confirmed)
VALUES ('cf-multi-source', 1, 'telegram', '@partner', 'copy', true);
INSERT INTO social_posts (id, project_id, body, telegram_text, channels, status)
VALUES ('cf-multi-ru', 1, 'Оригинал 123', '', 'telegram', 'ready'),
       ('cf-multi-en', 1, 'Original 123', '', 'telegram', 'ready');
INSERT INTO content_factory_items (id, project_id, source_id, external_id, original_text, generated_text,
  original_image_urls, original_image_files, processing_mode, copy_permission_confirmed,
  status, social_post_id, en_social_post_id, en_text, en_source_text, en_approved_at,
  en_rights_confirmed, en_account_id)
VALUES ('cf-multi-item', 1, 'cf-multi-source', '1', 'Оригинал 123', 'Оригинал 123',
  'u1,u2,u3,u4', '["a.jpg","b.jpg","c.jpg","d.jpg"]'::jsonb, 'copy', true,
  'needs_review', 'cf-multi-ru', 'cf-multi-en', 'Original 123', 'Оригинал 123', now(),
  true, 'cf-en-account');
INSERT INTO social_publications (id, project_id, social_post_id, social_account_id, platform)
VALUES ('cf-multi-ru-pub', 1, 'cf-multi-ru', 'cf-ru-account', 'telegram'),
       ('cf-multi-en-pub', 1, 'cf-multi-en', 'cf-en-account', 'telegram');

-- EN may be independently approved even while RU is awaiting approval.
UPDATE social_publications SET status = 'publishing' WHERE id = 'cf-multi-en-pub';
UPDATE social_publications SET status = 'draft' WHERE id = 'cf-multi-en-pub';
UPDATE social_posts SET body = 'Altered English' WHERE id = 'cf-multi-en';
DO $$ BEGIN
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'cf-multi-en-pub';
    RAISE EXCEPTION 'changed English text bypassed approval';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory EN approval and review are required before publication' THEN RAISE; END IF;
  END;
END $$;
UPDATE social_posts SET body = 'Original 123' WHERE id = 'cf-multi-en';
DO $$ BEGIN
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'cf-multi-ru-pub';
    RAISE EXCEPTION 'RU bypassed separate approval';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory RU approval and review are required before publication' THEN RAISE; END IF;
  END;
END $$;
UPDATE content_factory_items SET status = 'ready', copy_approved_at = now(),
  ru_account_id = 'cf-ru-account' WHERE id = 'cf-multi-item';
UPDATE content_factory_items SET ru_approved_at = now() WHERE id = 'cf-multi-item';
UPDATE social_publications SET status = 'publishing' WHERE id = 'cf-multi-ru-pub';
UPDATE social_publications SET status = 'draft' WHERE id = 'cf-multi-ru-pub';
-- A changed account clears its approval; the direct Social path must remain blocked.
UPDATE content_factory_items SET en_account_id = 'cf-ru-account' WHERE id = 'cf-multi-item';
DO $$ BEGIN
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'cf-multi-en-pub';
    RAISE EXCEPTION 'EN bypassed stale account approval';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory EN approval and review are required before publication' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
