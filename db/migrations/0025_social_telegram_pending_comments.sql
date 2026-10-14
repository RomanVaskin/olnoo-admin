-- Closes a residual race found in review of db/migrations/0024_social_telegram_pending_auto_forwards.sql:
-- a comment can arrive (and be classified "comment_unattributed") in the window before a post's
-- discussion thread is actually linked. Previously that comment was simply dropped — resolveThread
-- returning null meant handleTelegramCommentsUpdate never called insertCommentIfNew at all, and
-- Telegram never redelivers an update this app already answered 200 OK to (comment_unattributed is
-- treated as a handled outcome, not an error), so the comment was lost forever, not just delayed.
--
-- Fix: when resolveThread can't yet find a publication for a comment's (discussion_chat_id,
-- thread_id), the comment itself is kept here instead of discarded. The moment that thread IS
-- linked — whichever of linkAutoForward / resolvePendingAutoForwardForPublication (migration 0024)
-- performs the stamp — it also replays every pending comment for that (chat, thread) pair straight
-- into social_comments (lib/social-comments.ts's replayPendingComments), then deletes the rows here.
-- A replayed comment is inserted with notified_at left NULL, same as any other new comment — the
-- EXISTING retryUnnotifiedComments sweep (already run at the end of every webhook call) picks up its
-- notification on a later call; no new notifier wiring needed for this.
--
-- One row per distinct comment per thread — (discussion_chat_id, thread_id, external_comment_id) is
-- unique, so a webhook redelivery of the same comment update before its thread links is never
-- stored twice. Opportunistically pruned after 7 days on every insert (no new timer) — a comment on
-- a post made entirely outside OLNOO Admin (whose thread will never link) doesn't grow this table
-- forever; it is only ever a short-lived rendezvous point; social_comments remains the one durable
-- store for an actually-attributed comment.
--
-- Additive, idempotent, safe to re-run. No change to any other table or column.

CREATE TABLE IF NOT EXISTS social_telegram_pending_comments (
  id TEXT PRIMARY KEY,
  discussion_chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  external_comment_id TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  author_username TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  external_posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS social_telegram_pending_comments_external_id_uidx
  ON social_telegram_pending_comments (discussion_chat_id, thread_id, external_comment_id);

-- Supports the replay lookup: "which pending comments belong to the thread that was just linked?"
CREATE INDEX IF NOT EXISTS social_telegram_pending_comments_thread_idx
  ON social_telegram_pending_comments (discussion_chat_id, thread_id);
