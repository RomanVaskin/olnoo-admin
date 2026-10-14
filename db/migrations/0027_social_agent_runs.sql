-- OLNOO Social AI Agent MVP: turns one free-text task ("Подготовь три поста на неделю о
-- полировке автомобилей для DriveSet") into several REAL draft rows in the existing social_posts
-- table — no new content model, no new provider, no new DB. This migration adds exactly one small
-- idempotency/audit table; it does not touch social_posts, social_publications, or social_accounts.
-- Applied manually, not run automatically against production (same as every migration so far).
--
-- Why this table exists at all (requirement: "повторное подтверждение запроса не создаёт
-- дубликаты"): the agent's one write path (lib/social-agent.ts's runSocialAgentTask) is triggered
-- by a single free-text task with no natural stable key of its own — a double click, a client-side
-- network retry, or the exact same request arriving twice must not create a second batch of draft
-- posts. The client mints one `id` (a random UUID) per logical "run" of the agent and resends the
-- SAME id if retrying that same attempt; `id` here is that idempotency key, not a surrogate primary
-- key invented for its own sake.
--
-- The atomic claim (`INSERT ... ON CONFLICT (id, project_id) DO UPDATE ... WHERE status = 'failed'`)
-- is the SAME pattern db/migrations/0026_social_comment_replies.sql introduced for Telegram reply
-- retries, applied here instead to an agent run: a fresh id is claimed by the INSERT itself; a run
-- already `'completed'` is never reclaimed (the caller instead replays the SAME result, re-reading
-- `post_ids`, so a repeated confirmation is a no-op, never a second batch); a run still `'running'`
-- is refused (a genuinely concurrent duplicate); only a CONFIRMED `'failed'` run (the AI Router
-- itself errored, or post creation failed and was rolled back — see lib/social-agent.ts) can be
-- retried with the same id, atomically, never creating a second row for it.
--
-- The primary key is the composite (id, project_id), not `id` alone: `id` is a client-minted
-- idempotency key scoped to the project the client is working in, never intended to be globally
-- unique across every project. A plain `id PRIMARY KEY` let the SAME id collide across two
-- different projects at the `ON CONFLICT` level (Postgres resolves the conflict on `id` before
-- the WHERE clause can check project ownership), which could make one project's completed run
-- silently block another project's genuinely-fresh run reusing the same id. Composite-keying by
-- (id, project_id) makes every claim, replay, and retry fully project-scoped by construction, not
-- just by the defense-in-depth `WHERE project_id = …` already used on every read.
--
-- `post_ids` (comma-joined `social_posts.id` values) is populated only once every single post this
-- run is responsible for has been successfully created — see lib/social-agent.ts's own comment for
-- why an AI Router failure, or a failure partway through creating the posts, must never leave a
-- partially-created set: nothing here is marked `'completed'` (and `post_ids` stays empty) unless
-- the WHOLE batch succeeded.
--
-- Additive, idempotent, safe to re-run. No change to any other table or column.

CREATE TABLE IF NOT EXISTS social_agent_runs (
  id TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  post_ids TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, project_id)
);

CREATE INDEX IF NOT EXISTS social_agent_runs_project_id_idx ON social_agent_runs (project_id);
