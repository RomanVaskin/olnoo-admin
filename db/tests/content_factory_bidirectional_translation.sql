-- Run on disposable PostgreSQL after migration 0037; no Telegram calls or persistent changes.
BEGIN;
INSERT INTO social_accounts (id, project_id, platform, name, username, status)
VALUES ('cf-bi-ru-account', 1, 'telegram', 'RU', '@aurelmar', 'connected'),
       ('cf-bi-en-account', 1, 'telegram', 'EN', '@aurelmar_en', 'connected');
INSERT INTO content_factory_sources (id, project_id, type, handle, processing_mode, copy_permission_confirmed)
VALUES ('cf-bi-source', 1, 'telegram', '@partner', 'copy', true);
INSERT INTO social_posts (id, project_id, body, telegram_text, channels, status)
VALUES ('cf-bi-ru', 1, 'Готовый перевод 123', '', 'telegram', 'ready'),
       ('cf-bi-en', 1, 'Original post 123', '', 'telegram', 'ready');
INSERT INTO content_factory_items (id, project_id, source_id, external_id, original_text, generated_text,
  source_language, processing_mode, copy_permission_confirmed, copy_approved_at, status,
  social_post_id, en_social_post_id, ru_text, ru_source_text, ru_rights_confirmed,
  ru_approved_at, ru_account_id, en_approved_at, en_account_id)
VALUES ('cf-bi-item', 1, 'cf-bi-source', '1', 'Original post 123', 'Original post 123',
  'en', 'copy', true, now(), 'ready',
  'cf-bi-ru', 'cf-bi-en', 'Готовый перевод 123', 'Original post 123', true,
  now(), 'cf-bi-ru-account', now(), 'cf-bi-en-account');
INSERT INTO social_publications (id, project_id, social_post_id, social_account_id, platform)
VALUES ('cf-bi-ru-pub', 1, 'cf-bi-ru', 'cf-bi-ru-account', 'telegram'),
       ('cf-bi-en-pub', 1, 'cf-bi-en', 'cf-bi-en-account', 'telegram');

-- Both approved versions pass the same direct Social guard.
UPDATE social_publications SET status = 'publishing' WHERE id IN ('cf-bi-ru-pub', 'cf-bi-en-pub');
UPDATE social_publications SET status = 'draft' WHERE id IN ('cf-bi-ru-pub', 'cf-bi-en-pub');

-- Editing the RU translation invalidates only RU approval, and requires reapproval.
UPDATE content_factory_items SET ru_text = 'Исправленный перевод 123' WHERE id = 'cf-bi-item';
UPDATE social_posts SET body = 'Исправленный перевод 123' WHERE id = 'cf-bi-ru';
DO $$ BEGIN
  IF (SELECT ru_approved_at IS NOT NULL FROM content_factory_items WHERE id = 'cf-bi-item') THEN
    RAISE EXCEPTION 'RU approval survived a translation edit';
  END IF;
  IF (SELECT en_approved_at IS NULL FROM content_factory_items WHERE id = 'cf-bi-item') THEN
    RAISE EXCEPTION 'EN native approval was lost after a RU translation edit';
  END IF;
  BEGIN
    UPDATE social_publications SET status = 'publishing' WHERE id = 'cf-bi-ru-pub';
    RAISE EXCEPTION 'Unapproved RU translation was published';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Content Factory RU approval is required before publication' THEN RAISE; END IF;
  END;
END $$;
UPDATE content_factory_items SET ru_approved_at = now() WHERE id = 'cf-bi-item';
UPDATE social_publications SET status = 'publishing' WHERE id = 'cf-bi-ru-pub';
UPDATE social_publications SET status = 'draft' WHERE id = 'cf-bi-ru-pub';

-- A source edit invalidates the native approval and its dependent translation approval.
UPDATE content_factory_items SET generated_text = 'Edited original post 123' WHERE id = 'cf-bi-item';
DO $$ BEGIN
  IF (SELECT ru_approved_at IS NOT NULL OR en_approved_at IS NOT NULL
      FROM content_factory_items WHERE id = 'cf-bi-item') THEN
    RAISE EXCEPTION 'A source edit left a language approved';
  END IF;
END $$;
ROLLBACK;
