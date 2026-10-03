-- OLNOO Admin — AI cluster review («AI проверить все кластеры»)
-- Applied manually. Not run automatically against production.
-- The AI's CREATE / IMPROVE / IGNORE decision per cluster. The decision itself reuses the existing
-- AI layer (status, recommended_page_id, needs_new_page, reason); these columns only hold what has
-- no other home: the proposed slug / H1 / Title of a page to create, and the decision marker
-- (NULL = not reviewed by the AI yet). All nullable, so existing rows and code keep working.

ALTER TABLE seo_clusters ADD COLUMN IF NOT EXISTS ai_decision TEXT;
ALTER TABLE seo_clusters ADD COLUMN IF NOT EXISTS suggested_slug TEXT;
ALTER TABLE seo_clusters ADD COLUMN IF NOT EXISTS suggested_h1 TEXT;
ALTER TABLE seo_clusters ADD COLUMN IF NOT EXISTS suggested_title TEXT;
