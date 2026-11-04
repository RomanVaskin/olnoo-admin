-- Independent of unmerged 0041. Requires 0040; apply once before this Admin code.
BEGIN;
ALTER TABLE projects ADD COLUMN istraart_style_prompt TEXT
  CHECK (istraart_style_prompt IS NULL OR char_length(btrim(istraart_style_prompt)) BETWEEN 1 AND 16000);
ALTER TABLE catalog_cards
  ADD COLUMN manual_media JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(manual_media) = 'array'),
  ADD COLUMN manual_photo_selection JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(manual_photo_selection) = 'object');
COMMIT;
