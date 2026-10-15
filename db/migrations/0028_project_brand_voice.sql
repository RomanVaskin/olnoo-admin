-- OLNOO Social AI Agent 2.0, stage 1 — Brand Profile per project (feeds the unified AI context used
-- by Social Agent plan/draft generation, "Generate variants", and the new AI Editor).
-- Applied manually, like every migration so far. Additive only: one new table, nothing existing is
-- altered, no row is created by the migration (every project starts with no Brand Profile), and
-- existing code that never reads this table is entirely unaffected. Idempotent — safe to re-run
-- (CREATE TABLE IF NOT EXISTS), and never touches a row that already exists.
--
-- Same shape and convention as db/migrations/0013_project_seo_context.sql: one row per project,
-- free text edited from the existing Project admin screen (components/sections/projects-view.tsx),
-- read through lib/project-brand-voice.ts the same way project_seo_context is read through
-- lib/project-seo-context.ts. This is a genuinely new fact (target audience / tone / verified facts
-- / constraints / preferred CTA) that project_seo_context's columns (business type, region,
-- services, planned services, excluded) do not capture — reusing or overloading those columns was
-- considered and rejected, since they already have their own documented meaning for the SEO query
-- cleanup pipeline. The two tables stay independent; lib/project-ai-context.ts is what combines them
-- (and the project's own name/domain) into one reusable block for prompts, without duplicating either
-- table's data.
CREATE TABLE IF NOT EXISTS project_brand_voice (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  target_audience TEXT NOT NULL DEFAULT '',  -- who the content should speak to
  tone_style TEXT NOT NULL DEFAULT '',       -- communication style/tone (formal, playful, expert, ...)
  verified_facts TEXT NOT NULL DEFAULT '',   -- confirmed facts about the company, safe to state as true
  constraints TEXT NOT NULL DEFAULT '',      -- what must never be claimed or promised
  preferred_cta TEXT NOT NULL DEFAULT '',    -- the call to action to favor when one fits naturally
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
