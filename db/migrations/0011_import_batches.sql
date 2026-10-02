-- OLNOO Admin — Wordstat import batches
-- Applied manually. Not run automatically against production. Additive only: safe to apply
-- before the code that uses it is deployed (the previous code ignores these tables/column).

-- One user operation (N files imported together, or one transfer) = one batch.
CREATE TABLE IF NOT EXISTS import_batches (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 'import' (files uploaded into project_id) or 'transfer' (keywords moved into project_id
  -- from source_project_id).
  kind TEXT NOT NULL DEFAULT 'import',
  source_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  -- 'Imported', or 'Moved' once its keywords were transferred to another project.
  status TEXT NOT NULL DEFAULT 'Imported',
  files_count INTEGER NOT NULL DEFAULT 0,
  keywords_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_batches_project_created ON import_batches (project_id, created_at DESC);

-- Per-file log rows keep living in imports; a NULL batch_id marks a pre-batch (legacy) import.
ALTER TABLE imports ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_imports_batch_id ON imports (batch_id);

-- Exactly which keywords (query + region, not keyword ids — they survive a transfer) a batch
-- brought, and whether the batch created the keyword (true) or only updated an existing one.
CREATE TABLE IF NOT EXISTS import_batch_keywords (
  batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  frequency INTEGER,
  created BOOLEAN NOT NULL,
  PRIMARY KEY (batch_id, query, region)
);
