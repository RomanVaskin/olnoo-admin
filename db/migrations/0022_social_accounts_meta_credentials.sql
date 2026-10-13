-- Per-project Instagram/Threads credentials for Social Accounts — the same move 0021 already made
-- for VK, applied to the two remaining platforms that still used a single global, OWNER_PROJECT-
-- pinned env credential (lib/social-account-ownership.ts).
--
-- Root cause this fixes: an Instagram/Threads Login access token is scoped to exactly one external
-- account, so this app used one shared env credential (INSTAGRAM_ACCESS_TOKEN/ACCOUNT_ID,
-- THREADS_ACCESS_TOKEN/USER_ID) for every project, gated by an OWNER_PROJECT allowlist of exactly
-- one project. That keeps OLNOO's own publishing working, but makes it structurally impossible for
-- a second project to connect its own Instagram/Threads account. Each project's account can now
-- store its own token, same as VK: encrypted at rest (lib/social-account-crypto.ts), resolved from
-- the specific social_accounts row a publication is linked to, never shared across projects.
--
-- The global env-token path is NOT removed: it remains a deliberate, explicit fallback, still
-- gated by OWNER_PROJECT exactly as before (lib/social-account-ownership.ts untouched) — see
-- lib/social-instagram.ts / lib/social-threads.ts for the resolution order (per-account first).
--
-- instagram_access_token_encrypted / threads_access_token_encrypted: ciphertext only (AES-256-GCM,
--   iv+tag+ciphertext, base64) — never the plaintext token. Deliberately excluded from
--   ACCOUNT_COLUMNS in lib/social-accounts.ts, same as vk_access_token_encrypted.
-- instagram_account_id / threads_user_id: the numeric Instagram/Threads user id the token was last
--   verified against (lib/social-instagram-verify.ts / lib/social-threads-verify.ts) — what the
--   publisher calls the Graph API with. Not a secret, just the resolved identity.
-- instagram_token_expires_at / threads_token_expires_at: when the stored long-lived token is
--   expected to expire (Meta's documented ~60-day long-lived-token lifetime — see
--   lib/social-meta-token-refresh.ts). NULL means unknown/never verified. The publisher refuses to
--   use an expired token rather than attempting a call that would fail anyway.
--
-- `connection_error` and `status` (added/reused by 0021) are shared across every platform's
-- connection flow already — no new column needed for those.
--
-- Additive, idempotent, safe to re-run. No change to any other platform's columns or behavior.

ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS instagram_access_token_encrypted TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS instagram_account_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS instagram_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS threads_access_token_encrypted TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS threads_user_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS threads_token_expires_at TIMESTAMPTZ;
