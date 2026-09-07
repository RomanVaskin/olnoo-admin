-- OLNOO Admin — human review of AI cluster recommendations
-- Applied manually. Not run automatically against production.
--
-- seo_clusters.status already holds the AI's own classification of its recommendation
-- ("Existing page" / "No page" / "Needs review" / "Ignored") and is overwritten every time
-- clustering is regenerated. review_status is a separate, human-owned field: it starts at
-- 'pending' and only changes when a person confirms, reassigns, or dismisses a cluster.

ALTER TABLE seo_clusters
  ADD COLUMN IF NOT EXISTS confirmed_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE seo_clusters
  ADD CONSTRAINT seo_clusters_review_status_check
  CHECK (review_status IN ('pending', 'confirmed', 'no_page', 'ignored'));

CREATE INDEX IF NOT EXISTS idx_seo_clusters_review_status ON seo_clusters(review_status);
CREATE INDEX IF NOT EXISTS idx_seo_clusters_confirmed_page_id ON seo_clusters(confirmed_page_id);
