-- Social Community MVP: Telegram channel comments (read + notify, no replies/CRM yet).
-- Applied manually. Not run automatically against production (same as every migration so far).
--
-- Root problem: a Telegram channel's comments live in a separate, LINKED discussion supergroup,
-- not the channel itself — each channel post is auto-forwarded into that group, and viewer
-- comments are ordinary messages replying inside that forwarded post's thread. Telegram's own
-- `message_thread_id` is only unique WITHIN one chat (one discussion group), never globally, so a
-- comment event alone can't say which project it belongs to — it has to be resolved through which
-- `social_publications` row owns that specific (chat, thread) pair.
--
-- telegram_discussion_chat_id / telegram_discussion_thread_id on social_publications: learned
-- reactively, not configured by hand. When the bot (lib/telegram-comments-handler.ts, via
-- app/api/telegram/comments-webhook/route.ts) observes the channel's own post auto-forwarded into
-- its discussion group, it resolves which project owns that channel (via the project's already-
-- verified social_accounts.username — see "Telegram channel connection" in OLNOO_PROJECT_MAP.md)
-- and which publication row matches `forward_from_message_id` (== that row's own external_post_id,
-- Telegram's channel message id, already stored by lib/social-telegram.ts), then stamps these two
-- columns onto that one row. A later comment with the matching (chat_id, thread_id) pair is then
-- unambiguously this row's — and therefore this row's project's — comment. Neither column is a
-- secret; both are empty string until/unless a matching auto-forward is actually observed, so a
-- post nothing has forwarded yet (or a post made outside OLNOO Admin entirely) simply never gets
-- comments attributed to it — never guessed.
--
-- social_comments: one row per distinct Telegram comment, deduplicated by (project_id, platform,
-- external_comment_id) — webhook redelivery of the same update_id, or this app's own retry after a
-- transient failure, can never create a second row for the same real comment. social_publication_id
-- is nullable and ON DELETE SET NULL (same convention as social_publications.social_account_id):
-- deleting the post this comment was on must not delete the comment history.
--
-- Additive, idempotent, safe to re-run. No change to any other table or column.

ALTER TABLE social_publications
  ADD COLUMN IF NOT EXISTS telegram_discussion_chat_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS telegram_discussion_thread_id TEXT NOT NULL DEFAULT '';

-- Guards against two different publications ever claiming the same discussion thread (would mean
-- two posts' comments get merged) — defensive, since the webhook handler itself already only ever
-- sets these columns once per row (never re-links a row that already has a thread).
CREATE UNIQUE INDEX IF NOT EXISTS social_publications_discussion_thread_uidx
  ON social_publications (telegram_discussion_chat_id, telegram_discussion_thread_id)
  WHERE telegram_discussion_thread_id <> '';

CREATE TABLE IF NOT EXISTS social_comments (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  social_publication_id TEXT REFERENCES social_publications(id) ON DELETE SET NULL,
  platform TEXT NOT NULL DEFAULT 'telegram',
  external_comment_id TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  author_username TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  external_posted_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dedup key requirement 3 asks for: a repeated poll/redelivery of the same external comment
-- can never insert a second row. Scoped by project_id too (belt-and-suspenders isolation — even
-- though external_comment_id is already globally unique per Telegram chat in practice).
CREATE UNIQUE INDEX IF NOT EXISTS social_comments_external_id_uidx
  ON social_comments (project_id, platform, external_comment_id);

CREATE INDEX IF NOT EXISTS social_comments_project_id_idx ON social_comments (project_id);
CREATE INDEX IF NOT EXISTS social_comments_social_publication_id_idx ON social_comments (social_publication_id);
