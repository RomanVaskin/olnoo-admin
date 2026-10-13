import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { verifyInstagramAccountToken } from '@/lib/social-instagram-verify'
import { refreshInstagramLongLivedToken } from '@/lib/social-meta-token-refresh'
import { decryptAccountSecret, encryptAccountSecret } from '@/lib/social-account-crypto'

// Connects and re-verifies a project's own Instagram access token (Social → Accounts) — the
// per-account counterpart to lib/social-accounts-vk-connection.ts, giving Instagram the same
// "each project connects its own credential" model VK already has. lib/social-instagram.ts's
// publisher prefers this stored token over the global INSTAGRAM_ACCESS_TOKEN/ACCOUNT_ID env
// fallback — see db/migrations/0022_social_accounts_meta_credentials.sql and lib/social-instagram.ts.
//
// How a token is actually obtained (researched before writing this, per this task's own
// instruction not to assume): Meta's Instagram Login API issues a long-lived access token (~60
// days) for an Instagram professional (Business/Creator) account. An app whose own
// Instagram/Facebook accounts are added as Admins/Testers/Developers in the Meta App Dashboard can
// generate such a token for THOSE accounts directly from the dashboard, with no App Review needed
// — this is how OLNOO's own account works today. Onboarding an arbitrary THIRD-PARTY client's
// Instagram account through a one-click "Connect Instagram" OAuth button, without the client
// manually generating and pasting a token, requires the app to request `instagram_business_*`
// permissions at Advanced Access, which needs Meta App Review and Business Verification — that is
// NOT implemented here (see the PR description for the full list of blockers). What IS implemented
// is the safely-available part: a project admin pastes a long-lived token (obtained via the App
// Dashboard, same manual step as VK's community token today), and this module verifies it,
// resolves the actual account id, and stores it encrypted — exactly VK's existing flow, just for
// a token that has to come from Meta's dashboard/OAuth playground rather than VK's own UI.
export type InstagramConnectionResult = { error: string; status: number } | { row: Record<string, unknown> }

const ACCOUNT_COLUMNS =
  'id, project_id, platform, name, username, public_url, status, active, notes, vk_group_id, instagram_account_id, ' +
  'instagram_token_expires_at, connection_error, created_at, updated_at'

/**
 * Connects (new/replacement token) or re-checks (no token given — uses the one already stored) an
 * Instagram account's connection. Mirrors connectOrRecheckVkAccount's failure-handling split:
 *   - Recheck of the already-stored token failing means the EXISTING connection has actually lost
 *     access (revoked/expired token) — `status`/`connection_error` ARE persisted.
 *   - A new/replacement token failing to verify is just a bad attempt — nothing is persisted, so a
 *     typo can never knock out a connection that is still working.
 * On a recheck, a refresh is attempted FIRST (requirement: implement refresh only once the token
 * type's own requirements are checked — Instagram's refresh needs a token at least 24h old and not
 * yet expired; see lib/social-meta-token-refresh.ts). If the refresh succeeds, the new token and
 * its real expiry are what get verified and stored. If refresh is ineligible or fails (token too
 * young, already expired, revoked), this falls back to verifying the existing token as-is — a
 * refresh failure alone is never treated as a connection failure, since the stored token may still
 * be perfectly valid.
 * `username` is always set from Meta's own verified answer (`verified.identity.username`), never
 * kept as whatever was typed into the field before — a stale or manually-mistyped `username` must
 * never survive a successful connect/recheck against a DIFFERENT real identity, since the Accounts
 * UI shows this field as "which account this is," and the publisher must never look connected to
 * one account while actually holding a token for another. Falls back to the existing value only in
 * the (never observed, but handled) case where Meta's own answer carries no username at all.
 */
export async function connectOrRecheckInstagramAccount(
  id: string,
  projectSlug: string | null,
  newToken: string | null,
): Promise<InstagramConnectionResult> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const { rows } = await pool.query<{
    platform: string
    username: string
    status: string
    instagram_access_token_encrypted: string
  }>(
    'SELECT platform, username, status, instagram_access_token_encrypted FROM social_accounts WHERE id = $1 AND project_id = $2',
    [id, projectId],
  )
  const account = rows[0]
  if (!account) return { error: 'not found', status: 404 }
  if (account.platform !== 'instagram') return { error: 'this is not an Instagram account', status: 400 }

  const tokenToVerify = newToken?.trim() || null
  const isRecheckOfStoredToken = !tokenToVerify
  let tokenForVerify: string | null = tokenToVerify
  let expiresAt: Date | null = null

  if (!tokenForVerify) {
    if (!account.instagram_access_token_encrypted) {
      return { error: 'no Instagram access token is connected yet — provide one to connect this account', status: 400 }
    }
    let stored: string
    try {
      stored = decryptAccountSecret(account.instagram_access_token_encrypted)
    } catch (err) {
      return { error: `Could not decrypt the stored Instagram token: ${err instanceof Error ? err.message : String(err)}`, status: 500 }
    }
    const refreshed = await refreshInstagramLongLivedToken(stored)
    if (refreshed.ok) {
      tokenForVerify = refreshed.token
      expiresAt = refreshed.expiresAt
    } else {
      tokenForVerify = stored
    }
  }

  const verified = await verifyInstagramAccountToken(tokenForVerify)
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

  // A fresh/replacement token is brand new — too young to refresh yet (Instagram requires 24h of
  // age) — so it keeps Meta's documented long-lived default of ~60 days until the first recheck
  // actually refreshes it.
  if (!expiresAt) {
    expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
  }

  const encrypted = encryptAccountSecret(tokenForVerify)
  const nextUsername = verified.identity.username || account.username?.trim() || ''

  const { rows: updated } = await pool.query(
    `UPDATE social_accounts
     SET instagram_access_token_encrypted = $1, instagram_account_id = $2, instagram_token_expires_at = $3,
         status = 'connected', connection_error = '', username = $4, updated_at = now()
     WHERE id = $5 AND project_id = $6
     RETURNING ${ACCOUNT_COLUMNS}`,
    [encrypted, verified.identity.accountId, expiresAt.toISOString(), nextUsername, id, projectId],
  )
  return { row: updated[0] }
}
