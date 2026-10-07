-- SEO Observer v1 (roadmap step C): manual snapshots of search performance and the data model for future before/after.
-- Additive and idempotent. Applied MANUALLY (the deploy workflow runs no migrations): apply it BEFORE deploying the code
-- that reads/writes it.
--
--   seo_snapshots  one stored result of one provider for one project and period.
--                  provider: yandex_webmaster | yandex_metrika;  kind: queries | organic_pages
--                  rows: the normalised rows as JSONB (no per-query / per-page tables in v1).
--                  Only a successful provider answer is stored (0 rows is a real answer); a technical failure stores nothing.
--   page_changes   schema only for the future before/after: nothing writes to it in step C (no CRUD, no GitHub link).
CREATE TABLE IF NOT EXISTS seo_snapshots (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rows JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seo_snapshots_latest ON seo_snapshots (project_id, provider, kind, taken_at DESC);

CREATE TABLE IF NOT EXISTS page_changes (
  id BIGSERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  pr_url TEXT,
  merged_at TIMESTAMPTZ,
  cluster_ids JSONB,
  issue_codes JSONB,
  baseline_snapshot_id BIGINT REFERENCES seo_snapshots(id),
  after_snapshot_id BIGINT REFERENCES seo_snapshots(id),
  status TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
