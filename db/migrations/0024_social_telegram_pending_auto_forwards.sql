-- Fixes a real production bug found after db/migrations/0023_social_comments.sql shipped: Telegram
-- can deliver a channel post's automatic-forward webhook event (into the linked discussion group)
-- BEFORE this app's own publish call has committed social_publications.external_post_id for that
-- same post — sendMessage's HTTP response (and therefore our own DB write) can arrive after
-- Telegram has already forwarded the message and called our webhook. lib/social-comments.ts's
-- linkAutoForward matched purely against the already-committed external_post_id, so when it lost
-- this race the event found no publication row to stamp and was dropped forever — confirmed in
-- production for a real publication (telegram_discussion_chat_id / telegram_discussion_thread_id
-- both stayed empty, no comment for that post ever appeared in Social → Comments).
--
-- Fix: when linkAutoForward can't yet match a publication (the channel is known, but no
-- publication has this external_post_id YET), the raw event is kept here instead of discarded.
-- Once the publish call itself commits external_post_id (lib/social-telegram.ts, immediately
-- after its own success UPDATE), it checks this table for a pending event matching the account it
-- just published through and that same message id — if found, the thread is stamped onto
-- social_publications right there, and the row here is deleted (consumed, never reused). This
-- makes the thread link succeed regardless of which side — the webhook or the publish call —
-- commits first, with no queue, timer, or new service: the resolution runs inline, on whichever
-- side arrives second, the same "no separate infrastructure" approach as the rest of this feature.
--
-- One row per (discussion_chat_id, thread_id) — Telegram redelivering the same auto-forward
-- update refreshes the same row (ON CONFLICT DO UPDATE) instead of accumulating duplicates.
-- Opportunistically pruned after 7 days (lib/social-comments.ts, on every new pending insert) so a
-- post whose matching publish-side commit never arrives (a channel post made outside OLNOO Admin
-- entirely, or a publish attempt that ultimately failed) doesn't grow this table forever — it is
-- only ever a short-lived rendezvous point, never a second long-term store for the (chat, thread)
-- mapping (social_publications' own two columns remain the one source of truth for that).
--
-- Additive, idempotent, safe to re-run. No change to any other table or column.

CREATE TABLE IF NOT EXISTS social_telegram_pending_auto_forwards (
  id TEXT PRIMARY KEY,
  discussion_chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  forward_from_chat_id TEXT NOT NULL DEFAULT '',
  forward_from_chat_username TEXT NOT NULL DEFAULT '',
  forward_from_message_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A redelivered auto-forward update (same thread) refreshes this one row rather than creating a
-- second pending entry for the same thread.
CREATE UNIQUE INDEX IF NOT EXISTS social_telegram_pending_auto_forwards_thread_uidx
  ON social_telegram_pending_auto_forwards (discussion_chat_id, thread_id);

-- Supports the publish-side lookup: "is there a pending event for the message id we just
-- published?"
CREATE INDEX IF NOT EXISTS social_telegram_pending_auto_forwards_message_id_idx
  ON social_telegram_pending_auto_forwards (forward_from_message_id);
