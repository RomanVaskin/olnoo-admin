-- Per-project VK community credentials for Social Accounts.
--
-- Root cause this fixes: VK autoposting (lib/social-vk.ts) used one global VK_ACCESS_TOKEN env var
-- for every project, the same single-tenant shape Instagram/Threads had — a project's active,
-- project-scoped social_accounts row for 'vk' only proved that project *believed* VK was connected,
-- never that the global token actually pointed at *that* project's own community. Unlike
-- Instagram/Threads (fixed by pinning the global credential to one owner project), VK's token is
-- obtained manually per community (no Login-style single-account constraint), so the real fix is to
-- stop sharing one token at all: each project's VK community now connects its own access token,
-- stored per social_accounts row, encrypted at rest (lib/social-account-crypto.ts).
--
-- vk_access_token_encrypted: ciphertext only (AES-256-GCM, iv+tag+ciphertext, base64) — never the
--   plaintext token. Deliberately excluded from ACCOUNT_COLUMNS in lib/social-accounts.ts, so it is
--   never selected by the accounts list/detail API and never reaches the browser.
-- vk_group_id: the numeric VK community id the token was last verified against (lib/social-vk.ts's
--   wall.post needs owner_id = -vk_group_id). Not a secret — just the resolved identity, kept so
--   publishing doesn't need to re-resolve a screen name on every call.
-- connection_error: last VK API verification error, if any (lib/social-accounts-vk-connection.ts).
--   Not a secret — shown directly in the Accounts UI so a lost connection is visible before publish
--   is attempted.
--
-- Additive, idempotent, safe to re-run. No change to any other platform's columns or behavior.

ALTER TABLE social_accounts
  ADD COLUMN IF NOT EXISTS vk_access_token_encrypted TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS vk_group_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS connection_error TEXT NOT NULL DEFAULT '';
