-- Social Community: AI-suggested replies to Telegram channel comments (MVP).
-- Applied manually, not run automatically against production (same as every migration so far).
--
-- At most one REPLY ROW per comment, ever — the natural MVP model for "Предложить ответ": a human
-- reviews one AI-suggested (and editable) reply and either sends it or cancels; there is no
-- "reply to your own reply" or multi-reply thread here. The UNIQUE index on social_comment_id is
-- not just a data-modeling choice — it IS the no-double-send mechanism (requirement: "не отправляй
-- один ответ повторно при двойном нажатии или параллельных запросах"), together with the atomic
-- claim pattern lib/social-comment-reply.ts uses:
--
--   INSERT ... VALUES (..., 'sending', ...)
--   ON CONFLICT (social_comment_id) DO UPDATE SET status = 'sending', ...
--   WHERE social_comment_replies.status = 'failed'
--   RETURNING id
--
-- BEFORE calling Telegram at all. A fresh comment is claimed by the INSERT itself; a comment whose
-- one row is already 'failed' (a CONFIRMED, definitive rejection) is atomically reclaimed by the
-- UPDATE branch — a manual retry, never a second row. Postgres's row lock on the conflicting row
-- makes this serialize correctly under concurrency, same guarantee `claimPublicationForSending`
-- (lib/social-publication-claim.ts) gives the existing Social Publisher, one level down: whichever
-- concurrent request's turn comes first wins the claim; every other one — whether its own row is
-- still 'failed' at the moment it was read, or already 'sending'/'sent' from the start — sees its
-- own attempt silently discarded by the WHERE clause and gets no row back, so it is refused before
-- any Telegram call. 'sending' (unresolved/unknown outcome) and 'sent' (already delivered) are
-- NEVER retriable through this mechanism, by construction of the WHERE clause, not by a separate
-- check layered on top — there is no code path that flips either of those back to 'sending'.
--
-- status: 'sending' (claimed; also the terminal state for an UNKNOWN Telegram outcome — a timeout
-- or dropped connection never gets auto-retried, exactly like a stuck 'publishing' publication; a
-- human must check Telegram directly, and only a CONFIRMED failure — never an unresolved one — can
-- ever be retried from here), 'sent' (confirmed delivered — external_reply_message_id is the real
-- Telegram message id of the reply itself; terminal, never retriable), 'failed' (Telegram
-- definitively rejected the send — error holds its message; the ONE status a human can retry from,
-- via the "Повторить" action, which re-enters the same edit-and-confirm flow rather than
-- instantly resending the same text). No DB CHECK constraint, validated in application code — same
-- convention as every other enum-like column in this project (see social_publications.status,
-- ads_campaigns.platform/status).
--
-- Additive, idempotent, safe to re-run. No change to any other table or column.

CREATE TABLE IF NOT EXISTS social_comment_replies (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  social_comment_id TEXT NOT NULL REFERENCES social_comments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'sending',
  body TEXT NOT NULL DEFAULT '',
  external_reply_message_id TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The no-double-send guarantee itself — see the file-level comment above.
CREATE UNIQUE INDEX IF NOT EXISTS social_comment_replies_comment_id_uidx ON social_comment_replies (social_comment_id);

CREATE INDEX IF NOT EXISTS social_comment_replies_project_id_idx ON social_comment_replies (project_id);
