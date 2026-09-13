import type { Pool } from 'pg'
import { resolveProjectId } from '@/lib/crm'
import { syncPostStatusFromPublications } from '@/lib/social'
import { THREADS_TEXT_MAX_LENGTH, resolveThreadsText } from '@/lib/social-threads-text'

// Server-side only. THREADS_ACCESS_TOKEN and THREADS_USER_ID must never be sent to the browser —
// they are read here and only here, inside a function called exclusively from a server route
// handler. Like Instagram, the target account isn't resolved from social_accounts: a Threads
// access token is already scoped to one specific Threads user, so the user id comes from its own
// env var. social_accounts is still used, but only as a project-scoped "is Threads actually
// connected and active for this project" guard — its username stays the real @handle, never a
// token or numeric id.

export type SocialThreadsResult = { error: string; status: number } | { row: Record<string, unknown> }

// Overridable the same way TELEGRAM_API_BASE_URL/VK_API_BASE_URL/INSTAGRAM_API_BASE_URL override
// their own base URLs — not a secret, just lets a non-production environment point at a mock
// Threads API. Unlike graph.instagram.com, the Threads Graph API is versioned
// (https://graph.threads.net/v1.0/...), so the version segment is appended here.
const THREADS_API_BASE = `${process.env.THREADS_API_BASE_URL || 'https://graph.threads.net'}/v1.0`

// Meta recommends waiting ~30s for a text container to finish processing before publishing.
const CONTAINER_POLL_MAX_ATTEMPTS = 10
const CONTAINER_POLL_DELAY_MS = 3000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type ThreadsOutcome = { error: string } | { ok: true }

/** Bounded poll of a Threads media container's processing status (create container → poll →
 * publish, the same async-container model Instagram uses, but with Threads' own field names:
 * `status` — not `status_code` — with values IN_PROGRESS/FINISHED/ERROR/EXPIRED/PUBLISHED, and
 * `error_message` instead of a nested error object when processing fails). Never polls
 * indefinitely — after CONTAINER_POLL_MAX_ATTEMPTS this gives up and reports a retryable error
 * rather than hanging the request. */
async function waitForContainerFinished(containerId: string, token: string): Promise<ThreadsOutcome> {
  for (let attempt = 0; attempt < CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    const params = new URLSearchParams({ fields: 'status,error_message', access_token: token })
    const res = await fetch(`${THREADS_API_BASE}/${containerId}?${params.toString()}`)
    const data = await res.json().catch(() => null)
    if (!res.ok || data?.error) {
      return { error: (data?.error?.message as string) || `Threads API request failed (${res.status})` }
    }
    const status = data?.status
    if (status === 'FINISHED' || status === 'PUBLISHED') return { ok: true }
    if (status === 'ERROR') return { error: (data?.error_message as string) || 'Threads failed to process the post' }
    if (status === 'EXPIRED') return { error: 'Threads media container expired before it could be published' }
    if (attempt < CONTAINER_POLL_MAX_ATTEMPTS - 1) await sleep(CONTAINER_POLL_DELAY_MS)
  }
  return { error: 'Threads post processing did not finish in time — please retry' }
}

/**
 * Publishes one social_publications row (platform must be 'threads') via the official Threads
 * Graph API's content-publishing flow: create a text media container
 * (POST /{THREADS_USER_ID}/threads, media_type=TEXT) → bounded poll until the container's status
 * is FINISHED → publish it (POST /{THREADS_USER_ID}/threads_publish, creation_id) → best-effort
 * read back the published post's permalink (GET /{media-id}?fields=permalink). Text is
 * threads_text if the post has one, else the shared body. MVP is TEXT only — no image/video/
 * carousel/replies.
 *
 * Project-scoped like the rest of the Social module — a publication id from another project
 * resolves as not-found. Requires a project-scoped, active social_accounts row for platform
 * 'threads' to exist (linked via social_account_id if set, else the project's first active
 * threads account) purely as a connection guard — the actual API target user comes from
 * THREADS_USER_ID, since a Threads access token is already scoped to one user (never the
 * account's username/handle — that would not be a valid API user id).
 *
 * Never re-sends an already-published publication (duplicate protection: rejected before any
 * Threads API call). A Threads API error, a failed/expired container, or a network failure is not
 * thrown — it is written to the row as status='failed' with the error message, leaving
 * external_post_id/external_url untouched, so a later retry is just calling this again (the
 * 'published' guard is the only thing that ever blocks a call, and 'failed' doesn't trip it).
 * Unlike Instagram, a permalink that can't be read back is not treated as fatal — the post itself
 * already published successfully at that point.
 */
export async function publishSocialPublicationToThreads(
  pool: Pool,
  id: string,
  projectSlug: string | null,
): Promise<SocialThreadsResult> {
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

  if (publication.platform !== 'threads') {
    return { error: 'only Threads publications can be published through this endpoint', status: 400 }
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
    if (!account || account.platform !== 'threads') {
      return { error: 'linked account is not a Threads account', status: 400 }
    }
  } else {
    const { rows } = await pool.query<{ active: boolean }>(
      `SELECT active FROM social_accounts WHERE project_id = $1 AND platform = 'threads' AND active = true ORDER BY created_at ASC LIMIT 1`,
      [projectId],
    )
    account = rows[0]
  }
  if (!account) {
    return { error: 'no Threads account configured for this project', status: 400 }
  }
  if (!account.active) {
    return { error: 'the linked Threads account is not active', status: 400 }
  }

  const { rows: postRows } = await pool.query<{ threads_text: string; body: string }>(
    'SELECT threads_text, body FROM social_posts WHERE id = $1 AND project_id = $2',
    [publication.social_post_id, projectId],
  )
  const post = postRows[0]
  const text = resolveThreadsText(post?.threads_text, post?.body)
  if (!text) return { error: 'post has no content to publish', status: 400 }
  if (text.length > THREADS_TEXT_MAX_LENGTH) {
    return { error: `Threads posts are limited to ${THREADS_TEXT_MAX_LENGTH} characters (this one is ${text.length})`, status: 400 }
  }

  const userId = process.env.THREADS_USER_ID
  const token = process.env.THREADS_ACCESS_TOKEN
  if (!userId || !token) {
    return { error: 'THREADS_ACCESS_TOKEN/THREADS_USER_ID is not configured on the server', status: 500 }
  }

  let threadsError: string | null = null
  let mediaId: string | null = null
  let permalink: string | null = null
  try {
    const createParams = new URLSearchParams({ media_type: 'TEXT', text, access_token: token })
    const createRes = await fetch(`${THREADS_API_BASE}/${userId}/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: createParams.toString(),
    })
    const createData = await createRes.json().catch(() => null)
    if (!createRes.ok || createData?.error) {
      threadsError = (createData?.error?.message as string) || `Threads API request failed (${createRes.status})`
    } else {
      const containerId = createData?.id as string | undefined
      if (!containerId) {
        threadsError = 'Threads did not return a media container id'
      } else {
        const finished = await waitForContainerFinished(containerId, token)
        if ('error' in finished) {
          threadsError = finished.error
        } else {
          const publishParams = new URLSearchParams({ creation_id: containerId, access_token: token })
          const publishRes = await fetch(`${THREADS_API_BASE}/${userId}/threads_publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: publishParams.toString(),
          })
          const publishData = await publishRes.json().catch(() => null)
          if (!publishRes.ok || publishData?.error) {
            threadsError = (publishData?.error?.message as string) || `Threads API request failed (${publishRes.status})`
          } else {
            mediaId = (publishData?.id as string) || null
            if (!mediaId) {
              threadsError = 'Threads did not return a published post id'
            } else {
              // Best-effort only: the post already published successfully above, so a permalink
              // lookup failure here must not turn a successful publish into a reported failure.
              const permaParams = new URLSearchParams({ fields: 'permalink', access_token: token })
              const permaRes = await fetch(`${THREADS_API_BASE}/${mediaId}?${permaParams.toString()}`)
              const permaData = await permaRes.json().catch(() => null)
              if (permaRes.ok && !permaData?.error) {
                permalink = (permaData?.permalink as string) || null
              }
            }
          }
        }
      }
    }
  } catch (err) {
    threadsError = err instanceof Error ? err.message : String(err)
  }

  if (threadsError || !mediaId) {
    const { rows } = await pool.query(
      `UPDATE social_publications SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND project_id = $3 RETURNING *`,
      [threadsError || 'Threads did not return a published post id', id, projectId],
    )
    return { row: rows[0] }
  }

  const { rows } = await pool.query(
    `UPDATE social_publications
     SET status = 'published', external_post_id = $1, external_url = $2, error = '',
         published_at = coalesce(published_at, now()), updated_at = now()
     WHERE id = $3 AND project_id = $4 RETURNING *`,
    [mediaId, permalink || '', id, projectId],
  )
  await syncPostStatusFromPublications(publication.social_post_id, projectId)
  return { row: rows[0] }
}
