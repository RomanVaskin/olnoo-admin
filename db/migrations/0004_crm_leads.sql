-- OLNOO Admin — CRM module schema
-- Applied manually. Not run automatically against production.

-- Short, URL-stable identifier per project (matches the ?project= query param
-- already used by the app shell, e.g. project=olnoo), so modules can resolve
-- "which project" without hardcoding numeric ids.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;

UPDATE projects SET slug = 'olnoo' WHERE domain = 'https://olnoo.com' AND slug IS NULL;
UPDATE projects SET slug = 'insurance' WHERE domain = 'https://insurance.olnoo.com' AND slug IS NULL;
UPDATE projects SET slug = 'aura' WHERE domain = 'https://aura.olnoo.com' AND slug IS NULL;
UPDATE projects SET slug = 'marketing' WHERE domain = 'https://marketing.olnoo.com' AND slug IS NULL;

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'Direct',
  landing_page TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'New',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_project_id_idx ON leads (project_id);
CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC);
