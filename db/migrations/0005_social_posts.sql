-- OLNOO Admin — Social module schema
-- Applied manually. Not run automatically against production.

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  telegram_text TEXT NOT NULL DEFAULT '',
  instagram_text TEXT NOT NULL DEFAULT '',
  threads_text TEXT NOT NULL DEFAULT '',
  vk_text TEXT NOT NULL DEFAULT '',
  channels TEXT NOT NULL DEFAULT '',
  publish_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idea',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS social_posts_project_id_idx ON social_posts (project_id);
CREATE INDEX IF NOT EXISTS social_posts_created_at_idx ON social_posts (created_at DESC);
