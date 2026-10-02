-- OLNOO Admin — AI relevance cleanup of search queries (before clustering)
-- Applied manually. Not run automatically against production. Additive only: existing rows stay
-- exactly as they are (every keyword starts unclassified), no AI runs because of this migration,
-- and the previous code ignores the new columns.

-- NULL relevance_status = "AI has not checked this keyword yet" (also what an imported keyword gets).
-- 'uncertain' = "AI checked it and a human decision is needed" — a different state.
ALTER TABLE keywords
  ADD COLUMN IF NOT EXISTS relevance_status TEXT
    CHECK (relevance_status IN ('target', 'informational', 'uncertain', 'geo_mismatch', 'irrelevant')),
  ADD COLUMN IF NOT EXISTS relevance_confidence SMALLINT CHECK (relevance_confidence BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS relevance_reason TEXT,
  -- true = a person set relevance_status; ordinary cleanup never overwrites such a keyword.
  ADD COLUMN IF NOT EXISTS relevance_manual BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS relevance_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_keywords_project_relevance ON keywords (project_id, relevance_status);

-- NULL = this project does not use cleanup (legacy): clustering keeps taking every keyword.
-- Set (once) in the same transaction that saves the project's first cleaned batch: from then on
-- clustering only takes target/informational keywords, so new unclassified imports wait for cleanup.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS relevance_cleanup_at TIMESTAMPTZ;
