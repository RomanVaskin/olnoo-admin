-- OLNOO Admin — Instagram autoposting: one image is mandatory (Instagram has no text-only post).
-- Applied manually. Not run automatically against production.

ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS instagram_image_url TEXT NOT NULL DEFAULT '';
