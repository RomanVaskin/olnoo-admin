import type { Pool } from 'pg'
import { resolveProjectId } from '@/lib/crm'
import { syncPostStatusFromPublications } from '@/lib/social'

// Server-side only. TELEGRAM_BOT_TOKEN must never be sent to the browser — it is read here and
// only here, inside a function called exclusively from a server route handler.

export type SocialTelegramResult = { error: string; status: number } | { row: Record<string, unknown> }

// Overridable the same way AI_ROUTER_URL overrides lib/ai-router.ts's base URL — not a secret,
// just lets a non-production environment point at a mock Telegram Bot API for verification.
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'

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
 * Never re-sends an already-published publication (duplicate protection: rejected before any
 * Telegram API call). A Telegram API error or network failure is not thrown — it is written to
 * the row as status='failed' with the error message, so a later retry is just calling this again
 * (the 'published' guard is the only thing that ever blocks a call, and 'failed' doesn't trip it).
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
    return { error: 'only Telegram publications can be published through this endpoint', status: 400 }
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
  if (!text) return { error: 'post has no content to publish', status: 400 }

  let account: { username: string; platform?: string } | undefined
  if (publication.social_account_id) {
    const { rows } = await pool.query<{ username: string; platform: string }>(
      'SELECT username, platform FROM social_accounts WHERE id = $1 AND project_id = $2',
      [publication.social_account_id, projectId],
    )
    account = rows[0]
    if (!account || account.platform !== 'telegram') {
      return { error: 'linked account is not a Telegram account', status: 400 }
    }
  } else {
    const { rows } = await pool.query<{ username: string }>(
      `SELECT username FROM social_accounts WHERE project_id = $1 AND platform = 'telegram' AND active = true ORDER BY created_at ASC LIMIT 1`,
      [projectId],
    )
    account = rows[0]
  }
  if (!account || !account.username.trim()) {
    return { error: 'no Telegram account with a username is configured for this project', status: 400 }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    return { error: 'TELEGRAM_BOT_TOKEN is not configured on the server', status: 500 }
  }

  const chatId = chatIdFor(account.username)

  let telegramError: string | null = null
  let messageId: number | null = null
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.ok) {
      telegramError = (data && typeof data.description === 'string' && data.description) || `Telegram API request failed (${res.status})`
    } else {
      messageId = data.result?.message_id ?? null
    }
  } catch (err) {
    telegramError = err instanceof Error ? err.message : String(err)
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
  return { row: rows[0] }
}
