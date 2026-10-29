-- Контент-завод (Content Factory) — first working stage of a universal content pipeline:
-- source (so far: a public Telegram channel) -> discovered item -> AI-generated, independent text
-- -> handed to the EXISTING Social Posts/Publications module to publish. Not a new app, not a new
-- publishing system — social_posts/social_publications/social_accounts are untouched and still the
-- only thing that ever talks to a platform API. Applied manually, like every migration so far; not
-- run automatically against production.
--
-- Three new tables, all project-scoped (ON DELETE CASCADE from `projects`, same convention as
-- every other per-project table in this schema):
--
-- content_factory_sources — one row per monitored source. `type` is open-ended ('telegram' is the
-- only adapter implemented so far; 'rss'/'website'/'youtube' etc. are schema-ready, not
-- implemented — see lib/content-factory-sources.ts). `handle` is the adapter-specific address
-- (for telegram: a public channel username, with or without "@"/a t.me URL). `enabled` lets a
-- source be paused without deleting its history.
--
-- content_factory_items — the discovered-publications queue. `(source_id, external_id)` is UNIQUE
-- so the exact same source message can never be stored twice — `external_id` is whatever the
-- adapter considers a stable identity for one source publication (for telegram: the numeric
-- message id from the public preview). This is the one mechanism that prevents re-processing the
-- same message, required by the task ("Исключить повторную обработку одного сообщения" /
-- "Повторная проверка не создаёт дубликатов") — enforced by the DB itself, not just by
-- application-level care. `social_post_id` links to the existing `social_posts` row once one has
-- been created for this item (ON DELETE SET NULL — deleting a post never cascades into deleting
-- the item's own history); it is set at most once per item and is itself how a repeated "Publish"
-- click on an already-linked item stays idempotent (see lib/content-factory-publish.ts).
-- `status` is the task's own state machine: new -> processing -> ready -> scheduled -> published,
-- plus needs_review / rejected / failed (enforced in application code, not a CHECK constraint —
-- same posture `social_publications.status` already uses in this schema).
--
-- content_factory_settings — one row per project (PK = project_id, upsert-only, never multiple
-- rows per project), the "Автоматизация" screen's own settings. `mode` is manual / auto_review /
-- auto_publish, matching the task's three modes; `auto_publish=false` by default, matching the
-- task's own requirement ("Не включай автопубликацию по умолчанию") — nothing in this migration or
-- its application code flips it to true automatically. Storing these settings here does NOT by
-- itself make anything run automatically: see lib/content-factory-scheduler.ts's own comment for
-- exactly what the background sweep does and does not do yet in this first stage.
--
-- Additive, idempotent, safe to re-run. No change to any existing table or column.

CREATE TABLE IF NOT EXISTS content_factory_sources (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'telegram',
  handle TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_factory_sources_project_id_idx ON content_factory_sources (project_id);

CREATE TABLE IF NOT EXISTS content_factory_items (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES content_factory_sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  original_url TEXT NOT NULL DEFAULT '',
  original_text TEXT NOT NULL DEFAULT '',
  original_image_urls TEXT NOT NULL DEFAULT '',
  original_published_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'new',
  generated_title TEXT NOT NULL DEFAULT '',
  generated_text TEXT NOT NULL DEFAULT '',
  review_reason TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  social_post_id TEXT REFERENCES social_posts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS content_factory_items_project_id_idx ON content_factory_items (project_id);
CREATE INDEX IF NOT EXISTS content_factory_items_source_id_idx ON content_factory_items (source_id);
CREATE INDEX IF NOT EXISTS content_factory_items_status_idx ON content_factory_items (status);

CREATE TABLE IF NOT EXISTS content_factory_settings (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'manual',
  language TEXT NOT NULL DEFAULT '',
  allowed_topics TEXT NOT NULL DEFAULT '',
  max_posts_per_day INTEGER NOT NULL DEFAULT 3,
  schedule TEXT NOT NULL DEFAULT '',
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  auto_publish BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
