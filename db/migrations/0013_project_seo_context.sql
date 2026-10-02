-- OLNOO Admin — explicit SEO context per project (feeds AI query cleanup)
-- Applied manually. Not run automatically against production. Additive only: a new table, nothing
-- existing is altered, no row is created by the migration (every project starts with no context),
-- and the previous code ignores it. Code that reads it treats a missing table as "no context".

-- One row per project; each field is free text edited in SEO Admin (list fields: one item per line).
CREATE TABLE IF NOT EXISTS project_seo_context (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  business_type TEXT NOT NULL DEFAULT '',     -- what kind of business it is
  region TEXT NOT NULL DEFAULT '',            -- the region the business serves
  services TEXT NOT NULL DEFAULT '',          -- main services / products
  planned_services TEXT NOT NULL DEFAULT '',  -- additional / planned directions (count as part of the business)
  excluded TEXT NOT NULL DEFAULT '',          -- what the business explicitly does NOT sell or do
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
