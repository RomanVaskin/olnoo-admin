-- Social Community: AI-suggested replies to Telegram channel comments (MVP).
-- Applied manually, not run automatically against production (same as every migration so far).
--
-- One reply attempt per comment, ever — the natural MVP model for "Предложить ответ": a human
-- reviews one AI-suggested (and editable) reply and either sends it or cancels; there is no
-- "reply to your own reply" or multi-reply thread here. The UNIQUE index on social_comment_id is
-- not just a data-modeling choice — it IS the no-double-send mechanism (requirement: "не отправляй
-- один ответ повторно при двойном нажатии или параллельных запросах"), together with the atomic
-- claim pattern lib/social-comment-reply.ts uses: `INSERT ... ON CONFLICT (social_comment_id) DO
-- NOTHING RETURNING id` BEFORE calling Telegram at all. Exactly one concurrent request can ever
-- win that insert; every other concurrent or later request — a double click, a retried request,
-- a second browser tab — sees `claimed: false` and never calls Telegram. Same mechanism and same
-- reasoning as lib/social-publication-claim.ts's `claimPublicationForSending` for the existing
-- Social Publisher, applied one level down (a comment reply instead of a post).
--
-- status: 'sending' (claimed; also the terminal state for an UNKNOWN Telegram outcome — a timeout
-- or dropped connection never gets auto-retried, exactly like a stuck 'publishing' publication; a
-- human must check Telegram directly before anything further happens to this row), 'sent'
-- (confirmed delivered — external_reply_message_id is the real Telegram message id of the reply
-- itself), 'failed' (Telegram definitively rejected the send — error holds its message). No DB
-- CHECK constraint, validated in application code — same convention as every other enum-like
-- column in this project (see social_publications.status, ads_campaigns.platform/status).
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
