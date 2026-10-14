import type { Pool } from 'pg'
import { resolveProjectId } from '@/lib/crm'
import { syncPostStatusFromPublications } from '@/lib/social'
import { recordPublicationPreflightFailure } from '@/lib/social-publication-preflight-failure'
import { claimPublicationForSending, publicationClaimConflictResult } from '@/lib/social-publication-claim'
import { resolvePendingAutoForwardForPublication } from '@/lib/social-comments'

// Server-side only. TELEGRAM_BOT_TOKEN must never be sent to the browser — it is read here and
// only here, inside a function called exclusively from a server route handler.

export type SocialTelegramResult = { error: string; status: number } | { row: Record<string, unknown> }

// Overridable the same way AI_ROUTER_URL overrides lib/ai-router.ts's base URL — not a secret,
// just lets a non-production environment point at a mock Telegram Bot API for verification.
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'

// Bounds how long the one, irreversible sendMessage call may hang before this is treated as an
// unconfirmable ("unknown") outcome rather than left to hang the request indefinitely. Only this
// specific call gets a timeout — every earlier query/check is a safe-to-retry local read.
const SEND_TIMEOUT_MS = 20_000

/** Telegram's sendMessage chat_id accepts "@channelusername" or a numeric chat id — anything
 * else stored in social_accounts.username (e.g. a bare handle without "@") gets the "@" added. */
function chatIdFor(username: string): string {
  const trimmed = username.trim()
  if (!trimmed || trimmed.startsWith('@') || /^-?\d+$/.test(trimmed)) return trimmed
  return `@${trimmed}`
}

function externalUrlFor(username: string, messageId: number): string {
  const handle = username.trim().replace(/^@/, '')
  return `https://t.me/${handle}/${messageId}`
}

/**
 * Publishes one social_publications row (platform must be 'telegram') via the Telegram Bot API's
 * sendMessage. Text is telegram_text if the post has one, else the shared body. The target chat
 * is the linked social_accounts row (publication.social_account_id) if set, else the project's
 * first active telegram account. Project-scoped like the rest of the Social module — a
 * publication id from another project resolves as not-found.
 *
 * Never re-sends an already-published publication, and never sends it twice concurrently: right
 * before sendMessage, `claimPublicationForSending` atomically transitions the row to 'publishing'
 * — only one caller can ever win that (see lib/social-publication-claim.ts); every other caller
 * (a concurrent click, the scheduler, a stuck row from a previous attempt) is refused with 409
 * before any Telegram API call.
 *
 * A definitive Telegram API rejection (a response was received, just not a success one) is
 * written to the row as status='failed' with the error message, so a later retry is just calling
 * this again. A send whose outcome is genuinely UNKNOWN — sendMessage's own fetch() never got a
 * response at all (a timeout, a dropped connection) — is deliberately NOT written as 'failed': the
 * message may or may not have actually reached Telegram, so the row is left at 'publishing'
 * (nothing further is written) and a 503 is returned instead, so it is never auto-retried either
 * (see lib/social-publish-selected-targets.ts) — only a human who has checked Telegram directly
 * can resolve it.
 */
export async function publishSocialPublicationToTelegram(
  pool: Pool,
  id: string,
  projectSlug: string | null,
): Promise<SocialTelegramResult> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const { rows: pubRows } = await pool.query<{
    id: string
    social_post_id: string
    social_account_id: string | null
    platform: string
    status: string
  }>('SELECT * FROM social_publications WHERE id = $1 AND project_id = $2', [id, projectId])
  const publication = pubRows[0]
  if (!publication) return { error: 'not found', status: 404 }

  if (publication.platform !== 'telegram') {
    const error = 'only Telegram publications can be published through this endpoint'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }
  if (publication.status === 'published') {
    return { error: 'this publication is already published', status: 409 }
  }

  const { rows: postRows } = await pool.query<{ telegram_text: string; body: string }>(
    'SELECT telegram_text, body FROM social_posts WHERE id = $1 AND project_id = $2',
    [publication.social_post_id, projectId],
  )
  const post = postRows[0]
  const text = post?.telegram_text?.trim() || post?.body?.trim() || ''
  if (!text) {
    const error = 'post has no content to publish'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }

  let account: { username: string; platform?: string } | undefined
  if (publication.social_account_id) {
    const { rows } = await pool.query<{ username: string; platform: string }>(
      'SELECT username, platform FROM social_accounts WHERE id = $1 AND project_id = $2',
      [publication.social_account_id, projectId],
    )
    account = rows[0]
    if (!account || account.platform !== 'telegram') {
      const error = 'linked account is not a Telegram account'
      await recordPublicationPreflightFailure(pool, id, projectId, error)
      return { error, status: 400 }
    }
  } else {
    const { rows } = await pool.query<{ username: string }>(
      `SELECT username FROM social_accounts WHERE project_id = $1 AND platform = 'telegram' AND active = true ORDER BY created_at ASC LIMIT 1`,
      [projectId],
    )
    account = rows[0]
  }
  if (!account || !account.username.trim()) {
    const error = 'no Telegram account with a username is configured for this project'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    const error = 'TELEGRAM_BOT_TOKEN is not configured on the server'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 500 }
  }

  const chatId = chatIdFor(account.username)

  // Atomic claim, right before the one irreversible call — see claimPublicationForSending's own
  // comment. Every pre-flight check above is a safe-to-repeat local read; only sendMessage itself
  // can actually cause a duplicate, so only it needs to be guarded.
  const claim = await claimPublicationForSending(pool, id, projectId)
  if (!claim.claimed) return publicationClaimConflictResult(claim.currentStatus)

  let telegramError: string | null = null
  let messageId: number | null = null
  let sendOutcomeUnknown = false
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    // A response was received — a success or a rejection, Telegram definitively answered either
    // way. But a 2xx status is only a PARTIAL confirmation: if the body itself then fails to read
    // (the connection drops mid-stream, after the status line but before the full response), we
    // genuinely don't know whether the message went out — Telegram's 2xx strongly suggests it did,
    // so this must NOT be treated as a confirmed failure (which would wrongly allow a retry that
    // could send the same message twice). A non-2xx status is still a confirmed rejection
    // regardless of whether its body can be read.
    let data: unknown = null
    let bodyReadFailed = false
    try {
      data = await res.json()
    } catch {
      bodyReadFailed = true
    }
    if (res.ok && bodyReadFailed) {
      telegramError = 'Telegram returned a success status but the response body could not be read'
      sendOutcomeUnknown = true
    } else if (!res.ok || !(data as { ok?: boolean } | null)?.ok) {
      const errorData = data as { description?: unknown } | null
      telegramError = (errorData && typeof errorData.description === 'string' && errorData.description) || `Telegram API request failed (${res.status})`
    } else {
      messageId = (data as { result?: { message_id?: number } }).result?.message_id ?? null
    }
  } catch (err) {
    // fetch() itself threw — a timeout (AbortSignal above) or a dropped connection before any
    // response at all. Telegram never answered, so the message may or may not have actually gone
    // out. This is NOT a confirmed failure.
    telegramError = err instanceof Error ? err.message : String(err)
    sendOutcomeUnknown = true
  }

  if (sendOutcomeUnknown) {
    // Deliberately no DB write here — the row stays 'publishing' from the claim above, which
    // already keeps it out of every automatic retry path (see shouldAttemptPublicationTarget).
    return {
      error: `Could not confirm whether Telegram received the message: ${telegramError}. The publication is left as "publishing" — check Telegram directly before retrying manually.`,
      status: 503,
    }
  }

  if (telegramError || !messageId) {
    const { rows } = await pool.query(
      `UPDATE social_publications SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND project_id = $3 RETURNING *`,
      [telegramError || 'Telegram did not return a message id', id, projectId],
    )
    return { row: rows[0] }
  }

  const externalUrl = externalUrlFor(account.username, messageId)
  const { rows } = await pool.query(
    `UPDATE social_publications
     SET status = 'published', external_post_id = $1, external_url = $2, error = '',
         published_at = coalesce(published_at, now()), updated_at = now()
     WHERE id = $3 AND project_id = $4 RETURNING *`,
    [String(messageId), externalUrl, id, projectId],
  )
  await syncPostStatusFromPublications(publication.social_post_id, projectId)

  // The other half of the Social Community comments race fix (db/migrations/
  // 0024_social_telegram_pending_auto_forwards.sql): Telegram's automatic-forward webhook for THIS
  // exact post can arrive before the UPDATE above commits — external_post_id didn't exist yet when
  // the webhook handler looked for a matching publication, so it stored the event as pending
  // instead of losing it. Now that external_post_id is committed, check for exactly that. Never
  // lets a failure here affect the publish result itself, which has already fully succeeded —
  // same "never risk already-committed state" contract as lib/social-comment-notify.ts.
  try {
    await resolvePendingAutoForwardForPublication(pool, projectId, id, account.username, String(messageId))
  } catch (err) {
    console.error('[social-telegram] resolving a pending discussion-thread link failed (publish itself still succeeded):', err instanceof Error ? err.message : err)
  }

  return { row: rows[0] }
}
