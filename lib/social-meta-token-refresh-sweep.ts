import type { Pool } from 'pg'
import { decryptAccountSecret, encryptAccountSecret } from './social-account-crypto.ts'
import { refreshInstagramLongLivedToken, refreshThreadsLongLivedToken, type MetaTokenRefreshResult } from './social-meta-token-refresh.ts'
import { REFRESH_WINDOW_DAYS } from './social-meta-token-refresh-window.ts'

// No `@/` imports — only the `pg` package's own `Pool` type plus two already-dependency-free
// sibling modules — so this is directly testable under `node --test` against a real (or
// gracefully-skipped) Postgres, same convention as lib/social-publication-claim.ts.
//
// Daily, low-frequency sweep that keeps per-account Instagram/Threads tokens (social_accounts,
// connected via lib/social-accounts-instagram-connection.ts / lib/social-accounts-threads-
// connection.ts — see OLNOO_PROJECT_MAP.md's "Social Connect MVP") refreshed BEFORE they expire,
// without a human having to click "Recheck connection" manually. Triggered the same way the
// existing Social scheduler is — a systemd timer POSTing to an authenticated route — not a new
// service, queue, or Redis; see app/api/social-token-refresh/run/route.ts and
// deploy/social-token-refresh/.
//
// Deliberately NOT folded into lib/social-scheduler.ts's own once-a-minute sweep (that function's
// atomic-claim/advisory-lock invariants were specifically hardened by PR-56/57 to stay narrow —
// see OLNOO_PROJECT_MAP.md's own note on why this was evaluated and rejected there). This sweep
// runs independently, once a day, and touches a completely different table/column set
// (social_accounts' credentials, never social_publications).
//
// Meta's own refresh eligibility (confirmed in lib/social-meta-token-refresh.ts's own comment
// before any of this was written): a long-lived token must be at least 24h old and not yet
// expired. This sweep never tracks a separate "issued at" timestamp to check the 24h-minimum-age
// rule directly — it doesn't need to: REFRESH_WINDOW_DAYS only ever selects tokens that are close
// to their ~60-day expiry, so by construction every selected token has already lived for weeks,
// far past the 24h minimum. An already-EXPIRED token is explicitly excluded by the `> now()`
// bound below — Meta's refresh endpoint cannot revive one anyway, and the existing publish-time
// check (lib/social-instagram.ts / lib/social-threads.ts) already fails closed with a clear
// "reconnect" error for that case; this sweep does not change that.

type MetaPlatformConfig = {
  platform: 'instagram' | 'threads'
  tokenColumn: 'instagram_access_token_encrypted' | 'threads_access_token_encrypted'
  expiresColumn: 'instagram_token_expires_at' | 'threads_token_expires_at'
  refresh: (token: string) => Promise<MetaTokenRefreshResult>
}

const PLATFORMS: readonly MetaPlatformConfig[] = [
  {
    platform: 'instagram',
    tokenColumn: 'instagram_access_token_encrypted',
    expiresColumn: 'instagram_token_expires_at',
    refresh: refreshInstagramLongLivedToken,
  },
  {
    platform: 'threads',
    tokenColumn: 'threads_access_token_encrypted',
    expiresColumn: 'threads_token_expires_at',
    refresh: refreshThreadsLongLivedToken,
  },
]

export type RefreshSweepOutcome = {
  id: string
  projectId: number
  platform: 'instagram' | 'threads'
} & (
  | { outcome: 'refreshed' }
  | { outcome: 'skipped_raced' } // someone else (a manual recheck, or another sweep) already stored a newer token
  | { outcome: 'error'; error: string } // Meta rejected the refresh, or the stored ciphertext was undecryptable — connection left untouched
)

/**
 * Finds every `social_accounts` row (any project — this scans the whole table, not one project;
 * isolation is about never touching one project's row as a side effect of another's, not about
 * being scoped to a single project) whose per-account Instagram/Threads token expires within
 * `windowDays` and is not yet expired, and refreshes each one independently: one account's
 * failure (Meta rejects the refresh, or the stored ciphertext is corrupt) never stops or affects
 * any other account's attempt — same "no shared blast radius" principle as
 * lib/social-publish-selected.ts's per-channel isolation.
 *
 * A failed refresh is NEVER treated as a connection failure: `status`/the existing token/expiry
 * are left exactly as they were (the stored token may still be perfectly valid — a transient
 * network error or an early Meta-side hiccup is not proof the connection is broken), only
 * `connection_error` is updated so the Accounts UI can show it. This mirrors
 * lib/social-accounts-instagram-connection.ts's own "a refresh failure alone is never treated as
 * a connection failure" rule for the manual recheck path.
 */
export async function refreshExpiringMetaTokens(pool: Pool, windowDays: number = REFRESH_WINDOW_DAYS): Promise<RefreshSweepOutcome[]> {
  const results: RefreshSweepOutcome[] = []
  for (const cfg of PLATFORMS) {
    const { rows } = await pool.query<{ id: string; project_id: number; token: string }>(
      `SELECT id, project_id, ${cfg.tokenColumn} AS token
       FROM social_accounts
       WHERE platform = $1
         AND ${cfg.tokenColumn} <> ''
         AND ${cfg.expiresColumn} IS NOT NULL
         AND ${cfg.expiresColumn} > now()
         AND ${cfg.expiresColumn} <= now() + ($2 || ' days')::interval`,
      [cfg.platform, windowDays],
    )
    // Sequential, not Promise.all — same reasoning as lib/social-scheduler.ts's own sweep: keeps
    // load on the one production server and its DB pool predictable, and this runs once a day so
    // total latency is not a concern.
    for (const row of rows) {
      results.push(await refreshOneAccount(pool, cfg, row.id, row.project_id, row.token))
    }
  }
  return results
}

async function refreshOneAccount(
  pool: Pool,
  cfg: MetaPlatformConfig,
  id: string,
  projectId: number,
  encryptedToken: string,
): Promise<RefreshSweepOutcome> {
  let plaintext: string
  try {
    plaintext = decryptAccountSecret(encryptedToken)
  } catch (err) {
    const error = `Could not decrypt the stored ${cfg.platform} token: ${err instanceof Error ? err.message : String(err)}`
    await recordRefreshError(pool, cfg, id, projectId, encryptedToken, error)
    return { id, projectId, platform: cfg.platform, outcome: 'error', error }
  }

  const refreshed = await cfg.refresh(plaintext)
  if (!refreshed.ok) {
    await recordRefreshError(pool, cfg, id, projectId, encryptedToken, refreshed.error)
    return { id, projectId, platform: cfg.platform, outcome: 'error', error: refreshed.error }
  }

  const encrypted = encryptAccountSecret(refreshed.token)
  // Atomic, optimistic-concurrency update: the WHERE clause also pins the token column to the
  // EXACT ciphertext this call read moments ago. If a concurrent "Recheck connection" (or another
  // overlapping sweep run) already wrote a different token for this account in between, this
  // UPDATE matches zero rows — our own, now-stale, refresh result is discarded rather than
  // clobbering whatever newer token is already stored. AES-256-GCM's random IV means the same
  // plaintext never re-encrypts to the same ciphertext, so this equality check can never produce
  // a false match against a *different* real update — only against the literal snapshot we read.
  const { rowCount } = await pool.query(
    `UPDATE social_accounts
     SET ${cfg.tokenColumn} = $1, ${cfg.expiresColumn} = $2, connection_error = '', updated_at = now()
     WHERE id = $3 AND project_id = $4 AND ${cfg.tokenColumn} = $5`,
    [encrypted, refreshed.expiresAt.toISOString(), id, projectId, encryptedToken],
  )
  if (!rowCount) {
    return { id, projectId, platform: cfg.platform, outcome: 'skipped_raced' }
  }
  return { id, projectId, platform: cfg.platform, outcome: 'refreshed' }
}

/** Never touches `status` — see refreshOneAccount's own comment on why a background refresh
 * failure must not disable a still-working connection. Same optimistic-concurrency guard as the
 * success path above: the WHERE clause pins the token column to the EXACT ciphertext this call
 * read moments ago, so if a concurrent "Recheck connection" (or an overlapping sweep run) already
 * replaced the token in between — meaning the account is fine now — this stale error is simply
 * discarded instead of being written over that newer, working state. */
async function recordRefreshError(
  pool: Pool,
  cfg: MetaPlatformConfig,
  id: string,
  projectId: number,
  encryptedToken: string,
  error: string,
): Promise<void> {
  await pool.query(
    `UPDATE social_accounts SET connection_error = $1, updated_at = now()
     WHERE id = $2 AND project_id = $3 AND ${cfg.tokenColumn} = $4`,
    [error, id, projectId, encryptedToken],
  )
}
