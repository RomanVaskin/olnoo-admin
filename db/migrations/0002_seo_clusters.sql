-- OLNOO Admin — AI keyword clustering schema
-- Applied manually. Not run automatically against production.

CREATE TABLE IF NOT EXISTS seo_clusters (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  primary_keyword_id INTEGER REFERENCES keywords(id) ON DELETE SET NULL,
  intent TEXT,
  total_frequency INTEGER,
  recommended_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  confidence INTEGER,
  needs_new_page BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Needs review',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seo_cluster_keywords (
  id SERIAL PRIMARY KEY,
  cluster_id INTEGER NOT NULL REFERENCES seo_clusters(id) ON DELETE CASCADE,
  keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cluster_id, keyword_id)
);

CREATE INDEX IF NOT EXISTS idx_seo_clusters_project_id ON seo_clusters(project_id);
CREATE INDEX IF NOT EXISTS idx_seo_cluster_keywords_cluster_id ON seo_cluster_keywords(cluster_id);
CREATE INDEX IF NOT EXISTS idx_seo_cluster_keywords_keyword_id ON seo_cluster_keywords(keyword_id);
