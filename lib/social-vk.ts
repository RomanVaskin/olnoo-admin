import type { Pool } from 'pg'
import { resolveProjectId } from '@/lib/crm'
import { syncPostStatusFromPublications } from '@/lib/social'

// Server-side only. VK_ACCESS_TOKEN must never be sent to the browser — it is read here and only
// here, inside a function called exclusively from a server route handler.

export type SocialVkResult = { error: string; status: number } | { row: Record<string, unknown> }

// Overridable the same way TELEGRAM_API_BASE_URL overrides lib/social-telegram.ts's base URL —
// not a secret, just lets a non-production environment point at a mock VK API for verification.
const VK_API_BASE = process.env.VK_API_BASE_URL || 'https://api.vk.com'

// https://dev.vk.com/en/method/wall.post — current stable API version as of this integration.
const VK_API_VERSION = '5.199'

function screenNameFromPublicUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const last = trimmed.split('/').pop() || ''
  return last.split('?')[0]
}

function externalUrlFor(ownerId: number, postId: number): string {
  return `https://vk.com/wall${ownerId}_${postId}`
}

/**
 * Resolves a stored social_accounts identifier (numeric group id, "-"-prefixed owner id, or a
 * screen name like "olnoo_ai"/"club12345") to a numeric wall.post owner_id (always negative — a
 * community, never a user profile). A non-numeric identifier is resolved server-side via VK's own
 * utils.resolveScreenName — no schema change needed to store a pre-resolved numeric id.
 */
async function resolveOwnerId(identifier: string, token: string): Promise<{ ownerId: number } | { error: string }> {
  const trimmed = identifier.trim()
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    return { ownerId: n < 0 ? n : -n }
  }

  const screenName = trimmed.replace(/^@/, '')
  const params = new URLSearchParams({ screen_name: screenName, access_token: token, v: VK_API_VERSION })
  const res = await fetch(`${VK_API_BASE}/method/utils.resolveScreenName?${params.toString()}`).catch((err) => {
    throw new Error(`Could not reach VK API: ${err instanceof Error ? err.message : String(err)}`)
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.error) {
    return { error: (data?.error?.error_msg as string) || `Could not resolve VK screen name "${screenName}"` }
  }

  const resolved = data?.response
  if (!resolved || !resolved.type || !resolved.object_id) {
    return { error: `VK screen name "${screenName}" was not found` }
  }
  if (resolved.type === 'user') {
    return { error: `"${screenName}" resolves to a VK user profile, not a community` }
  }
  return { ownerId: -Math.abs(Number(resolved.object_id)) }
}

/**
 * Publishes one social_publications row (platform must be 'vk') via the VK API's wall.post,
 * posting as the community (from_group=1). Text is vk_text if the post has one, else the shared
 * body. The target community is the linked social_accounts row (publication.social_account_id) if
 * set, else the project's first active vk account — resolved from that account's username (or,
 * if empty, the last path segment of its public_url) via VK's utils.resolveScreenName when it
 * isn't already a numeric id. Project-scoped like the rest of the Social module — a publication id
 * from another project resolves as not-found.
 *
 * Never re-sends an already-published publication (duplicate protection: rejected before any VK
 * API call). A VK API error or network failure is not thrown — it is written to the row as
 * status='failed' with the error message, leaving external_post_id/external_url untouched, so a
 * later retry is just calling this again (the 'published' guard is the only thing that ever blocks
 * a call, and 'failed' doesn't trip it).
 */
export async function publishSocialPublicationToVk(
  pool: Pool,
  id: string,
  projectSlug: string | null,
): Promise<SocialVkResult> {
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

  if (publication.platform !== 'vk') {
    return { error: 'only VK publications can be published through this endpoint', status: 400 }
  }
  if (publication.status === 'published') {
    return { error: 'this publication is already published', status: 409 }
  }

  const { rows: postRows } = await pool.query<{ vk_text: string; body: string }>(
    'SELECT vk_text, body FROM social_posts WHERE id = $1 AND project_id = $2',
    [publication.social_post_id, projectId],
  )
  const post = postRows[0]
  const text = post?.vk_text?.trim() || post?.body?.trim() || ''
  if (!text) return { error: 'post has no content to publish', status: 400 }

  let account: { username: string; public_url: string; platform?: string; active: boolean } | undefined
  if (publication.social_account_id) {
    const { rows } = await pool.query<{ username: string; public_url: string; platform: string; active: boolean }>(
      'SELECT username, public_url, platform, active FROM social_accounts WHERE id = $1 AND project_id = $2',
      [publication.social_account_id, projectId],
    )
    account = rows[0]
    if (!account || account.platform !== 'vk') {
      return { error: 'linked account is not a VK account', status: 400 }
    }
  } else {
    const { rows } = await pool.query<{ username: string; public_url: string; active: boolean }>(
      `SELECT username, public_url, active FROM social_accounts WHERE project_id = $1 AND platform = 'vk' AND active = true ORDER BY created_at ASC LIMIT 1`,
      [projectId],
    )
    account = rows[0]
  }
  if (!account) {
    return { error: 'no VK account configured for this project', status: 400 }
  }
  if (!account.active) {
    return { error: 'the linked VK account is not active', status: 400 }
  }

  const identifier = account.username?.trim() || screenNameFromPublicUrl(account.public_url || '')
  if (!identifier) {
    return { error: 'the VK account has no username or public URL to identify the community', status: 400 }
  }

  const token = process.env.VK_ACCESS_TOKEN
  if (!token) {
    return { error: 'VK_ACCESS_TOKEN is not configured on the server', status: 500 }
  }

  let vkError: string | null = null
  let postId: number | null = null
  let ownerId: number | null = null
  try {
    const resolved = await resolveOwnerId(identifier, token)
    if ('error' in resolved) {
      vkError = resolved.error
    } else {
      ownerId = resolved.ownerId
      const params = new URLSearchParams({
        owner_id: String(ownerId),
        message: text,
        from_group: '1',
        access_token: token,
        v: VK_API_VERSION,
      })
      const res = await fetch(`${VK_API_BASE}/method/wall.post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || data?.error) {
        vkError = (data && typeof data.error?.error_msg === 'string' && data.error.error_msg) || `VK API request failed (${res.status})`
      } else {
        postId = data?.response?.post_id ?? null
      }
    }
  } catch (err) {
    vkError = err instanceof Error ? err.message : String(err)
  }

  if (vkError || !postId || !ownerId) {
    const { rows } = await pool.query(
      `UPDATE social_publications SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND project_id = $3 RETURNING *`,
      [vkError || 'VK did not return a post id', id, projectId],
    )
    return { row: rows[0] }
  }

  const externalUrl = externalUrlFor(ownerId, postId)
  const { rows } = await pool.query(
    `UPDATE social_publications
     SET status = 'published', external_post_id = $1, external_url = $2, error = '',
         published_at = coalesce(published_at, now()), updated_at = now()
     WHERE id = $3 AND project_id = $4 RETURNING *`,
    [String(postId), externalUrl, id, projectId],
  )
  await syncPostStatusFromPublications(publication.social_post_id, projectId)
  return { row: rows[0] }
}
