import type { Pool } from 'pg'
import { resolveProjectId } from '@/lib/crm'
import { syncPostStatusFromPublications } from '@/lib/social'

// Server-side only. INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID must never be sent to the
// browser — they are read here and only here, inside a function called exclusively from a server
// route handler. Unlike Telegram/VK, the target account isn't resolved from social_accounts: an
// Instagram Login access token is already scoped to one specific account, so the account id comes
// from its own env var. social_accounts is still used, but only as a project-scoped "is Instagram
// actually connected and active for this project" guard — its username stays the real @handle,
// never a token or numeric id.

export type SocialInstagramResult = { error: string; status: number } | { row: Record<string, unknown> }

// Overridable the same way TELEGRAM_API_BASE_URL/VK_API_BASE_URL override their own base URLs —
// not a secret, just lets a non-production environment point at a mock Instagram API.
const IG_API_BASE = process.env.INSTAGRAM_API_BASE_URL || 'https://graph.instagram.com'

const CONTAINER_POLL_MAX_ATTEMPTS = 5
const CONTAINER_POLL_DELAY_MS = 1500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type IgOutcome = { error: string } | { ok: true }

/** Short, bounded poll of a media container's processing status (Instagram fetches/validates the
 * image server-side after container creation). Never polls indefinitely — after
 * CONTAINER_POLL_MAX_ATTEMPTS this gives up and reports a retryable error rather than hanging the
 * request. */
async function waitForContainerFinished(containerId: string, token: string): Promise<IgOutcome> {
  for (let attempt = 0; attempt < CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    const params = new URLSearchParams({ fields: 'status_code,status', access_token: token })
    const res = await fetch(`${IG_API_BASE}/${containerId}?${params.toString()}`)
    const data = await res.json().catch(() => null)
    if (!res.ok || data?.error) {
      return { error: (data?.error?.message as string) || `Instagram API request failed (${res.status})` }
    }
    const statusCode = data?.status_code
    if (statusCode === 'FINISHED') return { ok: true }
    if (statusCode === 'ERROR') return { error: (data?.status as string) || 'Instagram failed to process the media' }
    if (statusCode === 'EXPIRED') return { error: 'Instagram media container expired before it could be published' }
    if (attempt < CONTAINER_POLL_MAX_ATTEMPTS - 1) await sleep(CONTAINER_POLL_DELAY_MS)
  }
  return { error: 'Instagram media processing did not finish in time — please retry' }
}

/**
 * Publishes one social_publications row (platform must be 'instagram') via the Instagram API with
 * Instagram Login's content publishing flow: create a media container (image_url + caption) →
 * bounded poll until the container's status_code is FINISHED → publish the container → read back
 * the published media's permalink. Caption is instagram_text if the post has one, else the shared
 * body; the image is social_posts.instagram_image_url, which is mandatory (Instagram has no
 * text-only post) and never defaults to anything.
 *
 * Project-scoped like the rest of the Social module — a publication id from another project
 * resolves as not-found. Requires a project-scoped, active social_accounts row for platform
 * 'instagram' to exist (linked via social_account_id if set, else the project's first active
 * instagram account) purely as a connection guard — the actual API target account comes from
 * INSTAGRAM_ACCOUNT_ID, since an Instagram Login token is already scoped to one account.
 *
 * Never re-sends an already-published publication (duplicate protection: rejected before any
 * Instagram API call). An Instagram API error, a failed/expired container, or a network failure is
 * not thrown — it is written to the row as status='failed' with the error message, leaving
 * external_post_id/external_url untouched, so a later retry is just calling this again (the
 * 'published' guard is the only thing that ever blocks a call, and 'failed' doesn't trip it).
 */
export async function publishSocialPublicationToInstagram(
  pool: Pool,
  id: string,
  projectSlug: string | null,
): Promise<SocialInstagramResult> {
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

  if (publication.platform !== 'instagram') {
    return { error: 'only Instagram publications can be published through this endpoint', status: 400 }
  }
  if (publication.status === 'published') {
    return { error: 'this publication is already published', status: 409 }
  }

  let account: { platform?: string; active: boolean } | undefined
  if (publication.social_account_id) {
    const { rows } = await pool.query<{ platform: string; active: boolean }>(
      'SELECT platform, active FROM social_accounts WHERE id = $1 AND project_id = $2',
      [publication.social_account_id, projectId],
    )
    account = rows[0]
    if (!account || account.platform !== 'instagram') {
      return { error: 'linked account is not an Instagram account', status: 400 }
    }
  } else {
    const { rows } = await pool.query<{ active: boolean }>(
      `SELECT active FROM social_accounts WHERE project_id = $1 AND platform = 'instagram' AND active = true ORDER BY created_at ASC LIMIT 1`,
      [projectId],
    )
    account = rows[0]
  }
  if (!account) {
    return { error: 'no Instagram account configured for this project', status: 400 }
  }
  if (!account.active) {
    return { error: 'the linked Instagram account is not active', status: 400 }
  }

  const { rows: postRows } = await pool.query<{ instagram_text: string; body: string; instagram_image_url: string }>(
    'SELECT instagram_text, body, instagram_image_url FROM social_posts WHERE id = $1 AND project_id = $2',
    [publication.social_post_id, projectId],
  )
  const post = postRows[0]
  const caption = post?.instagram_text?.trim() || post?.body?.trim() || ''
  if (!caption) return { error: 'post has no content to publish', status: 400 }
  const imageUrl = post?.instagram_image_url?.trim() || ''
  if (!imageUrl) return { error: 'post has no Instagram image URL to publish', status: 400 }

  const accountId = process.env.INSTAGRAM_ACCOUNT_ID
  const token = process.env.INSTAGRAM_ACCESS_TOKEN
  if (!accountId || !token) {
    return { error: 'INSTAGRAM_ACCESS_TOKEN/INSTAGRAM_ACCOUNT_ID is not configured on the server', status: 500 }
  }

  let igError: string | null = null
  let mediaId: string | null = null
  let permalink: string | null = null
  try {
    const createParams = new URLSearchParams({ image_url: imageUrl, caption, access_token: token })
    const createRes = await fetch(`${IG_API_BASE}/${accountId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: createParams.toString(),
    })
    const createData = await createRes.json().catch(() => null)
    if (!createRes.ok || createData?.error) {
      igError = (createData?.error?.message as string) || `Instagram API request failed (${createRes.status})`
    } else {
      const containerId = createData?.id as string | undefined
      if (!containerId) {
        igError = 'Instagram did not return a media container id'
      } else {
        const finished = await waitForContainerFinished(containerId, token)
        if ('error' in finished) {
          igError = finished.error
        } else {
          const publishParams = new URLSearchParams({ creation_id: containerId, access_token: token })
          const publishRes = await fetch(`${IG_API_BASE}/${accountId}/media_publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: publishParams.toString(),
          })
          const publishData = await publishRes.json().catch(() => null)
          if (!publishRes.ok || publishData?.error) {
            igError = (publishData?.error?.message as string) || `Instagram API request failed (${publishRes.status})`
          } else {
            mediaId = (publishData?.id as string) || null
            if (!mediaId) {
              igError = 'Instagram did not return a published media id'
            } else {
              const permaParams = new URLSearchParams({ fields: 'permalink', access_token: token })
              const permaRes = await fetch(`${IG_API_BASE}/${mediaId}?${permaParams.toString()}`)
              const permaData = await permaRes.json().catch(() => null)
              if (!permaRes.ok || permaData?.error) {
                igError = (permaData?.error?.message as string) || `Instagram API request failed (${permaRes.status})`
              } else {
                permalink = (permaData?.permalink as string) || null
                if (!permalink) igError = 'Instagram did not return a permalink'
              }
            }
          }
        }
      }
    }
  } catch (err) {
    igError = err instanceof Error ? err.message : String(err)
  }

  if (igError || !mediaId || !permalink) {
    const { rows } = await pool.query(
      `UPDATE social_publications SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND project_id = $3 RETURNING *`,
      [igError || 'Instagram did not return a permalink', id, projectId],
    )
    return { row: rows[0] }
  }

  const { rows } = await pool.query(
    `UPDATE social_publications
     SET status = 'published', external_post_id = $1, external_url = $2, error = '',
         published_at = coalesce(published_at, now()), updated_at = now()
     WHERE id = $3 AND project_id = $4 RETURNING *`,
    [mediaId, permalink, id, projectId],
  )
  await syncPostStatusFromPublications(publication.social_post_id, projectId)
  return { row: rows[0] }
}
