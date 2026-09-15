-- OLNOO Admin — Ads module MVP: a single project-scoped campaigns table.
-- Applied manually. Not run automatically against production (same as every migration so far —
-- see OLNOO_PROJECT_MAP.md).

CREATE TABLE IF NOT EXISTS ads_campaigns (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  budget NUMERIC(14, 2) NOT NULL DEFAULT 0,
  spend NUMERIC(14, 2) NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  leads INTEGER NOT NULL DEFAULT 0,
  sales INTEGER NOT NULL DEFAULT 0,
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  -- Plain TEXT, not DATE/TIMESTAMPTZ — same deliberate simplification social_posts.publish_date
  -- already uses (see "Social scheduler" in OLNOO_PROJECT_MAP.md): avoids a timezone library for
  -- a single-server MVP, editable via a plain <input type="date">.
  started_at TEXT NOT NULL DEFAULT '',
  ended_at TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ads_campaigns_project_id_idx ON ads_campaigns (project_id);
