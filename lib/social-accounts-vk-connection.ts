import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { verifyVkGroupToken } from '@/lib/social-vk-verify'
import { decryptAccountSecret, encryptAccountSecret } from '@/lib/social-account-crypto'

// Connects and re-verifies a project's own VK community token (Social → Accounts), the thing
// lib/social-vk.ts's publisher now reads credentials from instead of a shared global token — see
// db/migrations/0021_social_accounts_vk_credentials.sql and lib/social-vk.ts for why. The actual
// VK API call (verifyVkGroupToken) lives in lib/social-vk-verify.ts, kept dependency-free so it's
// directly unit-tested by this project's plain node:test runner.

export type VkConnectionRow = {
  platform: string
  username: string
  public_url: string
  status: string
  vk_access_token_encrypted: string
}

export type VkConnectionResult = { error: string; status: number } | { row: Record<string, unknown> }

const ACCOUNT_COLUMNS =
  'id, project_id, platform, name, username, public_url, status, active, notes, vk_group_id, connection_error, created_at, updated_at'

/**
 * Connects (new/replacement token) or re-checks (no token given — uses the one already stored) a
 * VK account's connection. Only ever writes the new ciphertext/group id when verification actually
 * succeeds. On failure, the two cases are handled differently on purpose:
 *   - Recheck of the already-stored token failing means the EXISTING connection has actually lost
 *     access (revoked/expired token) — that is real, current state, so `status`/`connection_error`
 *     ARE persisted, which is exactly what requirement 6 (show status + error when access is lost)
 *     needs, visible without having to publish a post first.
 *   - A new/replacement token failing to verify is just a bad attempt — the account's existing
 *     connection (if any) is untouched, DB included: nothing is persisted, so a typo while trying to
 *     replace a token can never knock out a connection that is still working. The caller surfaces
 *     `verified.error` to the admin directly; the account itself is unchanged.
 * `username`/`public_url` are auto-filled from VK's own answer only if they were empty, never
 * overwritten.
 */
export async function connectOrRecheckVkAccount(
  id: string,
  projectSlug: string | null,
  newToken: string | null,
): Promise<VkConnectionResult> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const { rows } = await pool.query<VkConnectionRow>(
    'SELECT platform, username, public_url, status, vk_access_token_encrypted FROM social_accounts WHERE id = $1 AND project_id = $2',
    [id, projectId],
  )
  const account = rows[0]
  if (!account) return { error: 'not found', status: 404 }
  if (account.platform !== 'vk') return { error: 'this is not a VK account', status: 400 }

  const tokenToVerify = newToken?.trim() || null
  let tokenForDecrypt = tokenToVerify
  if (!tokenForDecrypt) {
    if (!account.vk_access_token_encrypted) {
      return { error: 'no VK access token is connected yet — provide one to connect this community', status: 400 }
    }
    try {
      tokenForDecrypt = decryptAccountSecret(account.vk_access_token_encrypted)
    } catch (err) {
      return { error: `Could not decrypt the stored VK token: ${err instanceof Error ? err.message : String(err)}`, status: 500 }
    }
  }

  const verified = await verifyVkGroupToken(tokenForDecrypt)
  const isRecheckOfStoredToken = !tokenToVerify

  if (!verified.ok) {
    if (isRecheckOfStoredToken) {
      const { rows: updated } = await pool.query(
        `UPDATE social_accounts SET status = 'error', connection_error = $1, updated_at = now() WHERE id = $2 AND project_id = $3 RETURNING ${ACCOUNT_COLUMNS}`,
        [verified.error, id, projectId],
      )
      return { row: updated[0] }
    }
    return { error: verified.error, status: 502 }
  }

  const encrypted = tokenToVerify ? encryptAccountSecret(tokenToVerify) : account.vk_access_token_encrypted
  const nextUsername = account.username?.trim() || verified.identity.screenName
  const nextPublicUrl = account.public_url?.trim() || (verified.identity.screenName ? `https://vk.com/${verified.identity.screenName}` : '')

  const { rows: updated } = await pool.query(
    `UPDATE social_accounts
     SET vk_access_token_encrypted = $1, vk_group_id = $2, status = 'connected', connection_error = '',
         username = $3, public_url = $4, updated_at = now()
     WHERE id = $5 AND project_id = $6
     RETURNING ${ACCOUNT_COLUMNS}`,
    [encrypted, verified.identity.groupId, nextUsername, nextPublicUrl, id, projectId],
  )
  return { row: updated[0] }
}
