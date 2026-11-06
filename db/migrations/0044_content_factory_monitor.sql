-- Apply once after 0043 and before Monitor code. No session/media bytes in PostgreSQL.
BEGIN;
ALTER TABLE content_factory_items ADD COLUMN original_telegram JSONB NOT NULL DEFAULT '{}'::jsonb
 CHECK (jsonb_typeof(original_telegram)='object');
CREATE FUNCTION content_factory_trusted_original_valid(item content_factory_items) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT COALESCE(item.original_telegram->>'transport'='mtproto' AND item.original_telegram->>'version'='1'
  AND item.original_telegram->>'complete'='true' AND item.original_image_error=''
  AND jsonb_typeof(item.original_telegram->'messages')='array'
  AND jsonb_array_length(item.original_telegram->'messages') BETWEEN 1 AND 10
  AND jsonb_array_length(item.original_telegram->'messageIds')=jsonb_array_length(item.original_telegram->'messages')
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(item.original_telegram->'messages') m WHERE m->>'text'<>'' OR jsonb_typeof(m->'media')='object')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(item.original_telegram->'messages') WITH ORDINALITY t(m,n)
    WHERE jsonb_typeof(m->'text')<>'string' OR jsonb_typeof(m->'entities')<>'array' OR m->>'id' IS DISTINCT FROM item.original_telegram->'messageIds'->>(n::int-1))
  AND item.original_text=(SELECT COALESCE(string_agg(m->>'text',E'\n\n' ORDER BY n) FILTER (WHERE m->>'text'<>''),'')
     FROM jsonb_array_elements(item.original_telegram->'messages') WITH ORDINALITY AS t(m,n)),false)
$$;
CREATE OR REPLACE FUNCTION content_factory_review_valid(item content_factory_items) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN item.processing_mode='copy' THEN COALESCE(
  item.copy_permission_confirmed AND item.copy_approved_at IS NOT NULL AND item.status IN ('ready','scheduled','failed','published')
  AND (item.original_text<>'' OR content_factory_trusted_original_valid(item)) AND item.generated_text=item.original_text AND item.image_filename=''
  AND item.original_image_error='' AND jsonb_array_length(item.original_image_files)=CASE WHEN item.original_image_urls='' THEN 0 ELSE cardinality(string_to_array(item.original_image_urls,',')) END
  AND (item.original_image_urls='' OR item.copy_image_permission_confirmed),false)
 ELSE COALESCE(item.ai_review->>'status'='passed' AND item.ai_review->>'risk' IN ('low','medium') AND item.ai_review->>'passed'='true'
  AND item.ai_review->'quality'->>'passed'='true' AND item.ai_review->>'reviewedTitle'=item.generated_title
  AND item.ai_review->>'reviewedText'=item.generated_text AND item.ai_review->>'reviewedImageFilename'=item.image_filename,false) END;
$$;
-- Preserve all existing language/account/translation/AI guards; only trusted media-only copy
-- may have empty text. Fail if the installed function differs from the expected 0037 contract.
DO $$ DECLARE definition TEXT; BEGIN
 SELECT pg_get_functiondef('content_factory_social_review_guard()'::regprocedure) INTO definition;
 IF position('OR expected_text = ''''' IN definition)=0 OR position('AND item.original_text <> ''''' IN definition)=0 THEN
   RAISE EXCEPTION 'Unexpected Social guard: verify migrations through 0037 before applying 0044';
 END IF;
 definition:=replace(definition,'OR expected_text = ''''','OR (expected_text = '''' AND NOT content_factory_trusted_original_valid(item))');
 definition:=replace(definition,'AND item.original_text <> ''''','AND (item.original_text <> '''' OR content_factory_trusted_original_valid(item))');
 EXECUTE definition;
END $$;
-- Metadata changes revoke approval exactly like text/media changes. Existing guard stays installed.
CREATE FUNCTION content_factory_monitor_change_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.original_telegram IS DISTINCT FROM OLD.original_telegram THEN
  NEW.copy_approved_at:=NULL; NEW.ru_approved_at:=NULL; NEW.en_approved_at:=NULL;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER content_factory_00_monitor_guard BEFORE UPDATE ON content_factory_items
 FOR EACH ROW EXECUTE FUNCTION content_factory_monitor_change_guard();
COMMIT;
