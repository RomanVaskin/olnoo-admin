-- Project registry MVP: `projects` becomes the single source of truth for the project list in the whole Admin.
-- Additive and idempotent; apply manually (the deploy workflow runs no migrations). The code needs `archived_at` and `locale`:
-- apply this migration BEFORE deploying the version that reads them.
--
--   archived_at  NULL = active; a timestamp = archived (hidden from selectors, overviews and «Check all»; data is kept;
--                restoring sets it back to NULL). There is no hard delete in the UI.
--   locale       optional default language of the project's site (e.g. 'ru', 'en'); NULL = not set.
--
-- Existing rows stay active (archived_at NULL). Rows without a slug get one derived from the first label of the domain host
-- (https://driveset.ru -> driveset) only when that slug is free; anything else is left NULL and shown as «no slug» in Projects.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS locale TEXT;

UPDATE projects p
   SET slug = s.candidate
  FROM (
    SELECT id, lower(regexp_replace(split_part(regexp_replace(domain, '^https?://(www\.)?', ''), '.', 1), '[^a-z0-9_-]', '', 'gi')) AS candidate
      FROM projects
     WHERE slug IS NULL
  ) s
 WHERE p.id = s.id
   AND p.slug IS NULL
   AND s.candidate ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
   AND NOT EXISTS (SELECT 1 FROM projects x WHERE x.slug = s.candidate);

CREATE INDEX IF NOT EXISTS idx_projects_active ON projects (id) WHERE archived_at IS NULL;
