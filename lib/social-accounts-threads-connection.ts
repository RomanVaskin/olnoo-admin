import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { verifyThreadsAccountToken } from '@/lib/social-threads-verify'
import { refreshThreadsLongLivedToken } from '@/lib/social-meta-token-refresh'
import { decryptAccountSecret, encryptAccountSecret } from '@/lib/social-account-crypto'

// Connects and re-verifies a project's own Threads access token (Social → Accounts) — the
// per-account counterpart to lib/social-accounts-vk-connection.ts / lib/social-accounts-instagram-
// connection.ts. lib/social-threads.ts's publisher prefers this stored token over the global
// THREADS_ACCESS_TOKEN/USER_ID env fallback — see db/migrations/0022_social_accounts_meta_
// credentials.sql and lib/social-threads.ts.
//
// Same real-world constraint as Instagram (see lib/social-accounts-instagram-connection.ts's own
// comment in full): a long-lived Threads token for an account the Meta app's own
// Admins/Testers/Developers list already includes can be obtained with no App Review. Onboarding
// an arbitrary third-party client's Threads account through a one-click OAuth flow needs
// `threads_basic`/`threads_content_publish` at Advanced Access, which needs App Review + Business
// Verification — not implemented here. What this module does is verify a manually-pasted
// long-lived token, resolve the actual Threads user id, and store it encrypted.
export type ThreadsConnectionResult = { error: string; status: number } | { row: Record<string, unknown> }

const ACCOUNT_COLUMNS =
  'id, project_id, platform, name, username, public_url, status, active, notes, vk_group_id, threads_user_id, ' +
  'threads_token_expires_at, connection_error, created_at, updated_at'

/**
 * Connects (new/replacement token) or re-checks (no token given) a Threads account's connection.
 * Mirrors connectOrRecheckInstagramAccount exactly, including the refresh-then-verify order on a
 * recheck (Threads' own refresh endpoint has the same 24h-minimum-age/not-yet-expired eligibility
 * as Instagram's — see lib/social-meta-token-refresh.ts) and the same failure-handling split
 * between a recheck (persists status='error') and a bad new/replacement token (does not).
 */
export async function connectOrRecheckThreadsAccount(
  id: string,
  projectSlug: string | null,
  newToken: string | null,
): Promise<ThreadsConnectionResult> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const { rows } = await pool.query<{
    platform: string
    username: string
    status: string
    threads_access_token_encrypted: string
  }>(
    'SELECT platform, username, status, threads_access_token_encrypted FROM social_accounts WHERE id = $1 AND project_id = $2',
    [id, projectId],
  )
  const account = rows[0]
  if (!account) return { error: 'not found', status: 404 }
  if (account.platform !== 'threads') return { error: 'this is not a Threads account', status: 400 }

  const tokenToVerify = newToken?.trim() || null
  const isRecheckOfStoredToken = !tokenToVerify
  let tokenForVerify: string | null = tokenToVerify
  let expiresAt: Date | null = null

  if (!tokenForVerify) {
    if (!account.threads_access_token_encrypted) {
      return { error: 'no Threads access token is connected yet — provide one to connect this account', status: 400 }
    }
    let stored: string
    try {
      stored = decryptAccountSecret(account.threads_access_token_encrypted)
    } catch (err) {
      return { error: `Could not decrypt the stored Threads token: ${err instanceof Error ? err.message : String(err)}`, status: 500 }
    }
    const refreshed = await refreshThreadsLongLivedToken(stored)
    if (refreshed.ok) {
      tokenForVerify = refreshed.token
      expiresAt = refreshed.expiresAt
    } else {
      tokenForVerify = stored
    }
  }

  const verified = await verifyThreadsAccountToken(tokenForVerify)
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

  if (!expiresAt) {
    expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
  }

  const encrypted = encryptAccountSecret(tokenForVerify)
  const nextUsername = account.username?.trim() || verified.identity.username

  const { rows: updated } = await pool.query(
    `UPDATE social_accounts
     SET threads_access_token_encrypted = $1, threads_user_id = $2, threads_token_expires_at = $3,
         status = 'connected', connection_error = '', username = $4, updated_at = now()
     WHERE id = $5 AND project_id = $6
     RETURNING ${ACCOUNT_COLUMNS}`,
    [encrypted, verified.identity.userId, expiresAt.toISOString(), nextUsername, id, projectId],
  )
  return { row: updated[0] }
}
