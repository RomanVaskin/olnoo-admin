-- Technical SEO closed loop (roadmap step B). Additive and idempotent; apply manually (the deploy workflow runs no migrations).
-- The code reads `projects.repository` in the Project Registry: apply this migration BEFORE merging/deploying the version that reads it.
--
--   repository               GitHub `owner/repo` of the project's site (e.g. RomanVaskin/driveset); NULL = not set. Never guessed.
--   seo_health_last_result   the LAST Technical SEO check (ProjectHealth JSON, up to 100 checked pages). Overwritten by every check;
--                            there is no history. Deliberately NOT part of the Project Registry's shared SELECT.
--   seo_health_checked_at    when that last check ran; NULL = never checked.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repository TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS seo_health_last_result JSONB;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS seo_health_checked_at TIMESTAMPTZ;
