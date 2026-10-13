import type { Pool } from 'pg'
import { resolveProjectId } from '@/lib/crm'
import { syncPostStatusFromPublications } from '@/lib/social'
import { THREADS_TEXT_MAX_LENGTH, resolveThreadsText } from '@/lib/social-threads-text'
import { compareAccountOwnership, resolveOwnerProjectSlug, verifyProjectIsAllowed } from '@/lib/social-account-ownership'
import { recordPublicationPreflightFailure } from '@/lib/social-publication-preflight-failure'
import { claimPublicationForSending, publicationClaimConflictResult } from '@/lib/social-publication-claim'

// Server-side only. THREADS_ACCESS_TOKEN and THREADS_USER_ID must never be sent to the browser —
// they are read here and only here, inside a function called exclusively from a server route
// handler. Like Instagram, the target account isn't resolved from social_accounts: a Threads
// access token is already scoped to one specific Threads user, so the user id comes from its own
// env var — global across every project. THREADS_OWNER_PROJECT names the one project allowed to
// use it at all; social_accounts is still used too, both as a project-scoped "is Threads actually
// connected and active for this project" guard, AND as the known-good @handle an ownership check
// compares the actually-connected account's username against before any publish call is made —
// but neither social_accounts row nor username match is, by itself, the authorization. See
// lib/social-account-ownership.ts for why.

export type SocialThreadsResult = { error: string; status: number } | { row: Record<string, unknown> }

// Overridable the same way TELEGRAM_API_BASE_URL/VK_API_BASE_URL/INSTAGRAM_API_BASE_URL override
// their own base URLs — not a secret, just lets a non-production environment point at a mock
// Threads API. Unlike graph.instagram.com, the Threads Graph API is versioned
// (https://graph.threads.net/v1.0/...), so the version segment is appended here.
const THREADS_API_BASE = `${process.env.THREADS_API_BASE_URL || 'https://graph.threads.net'}/v1.0`

// Meta recommends waiting ~30s for a text container to finish processing before publishing.
const CONTAINER_POLL_MAX_ATTEMPTS = 10
const CONTAINER_POLL_DELAY_MS = 3000

// Bounds how long the one, irreversible threads_publish call may hang before this is treated as
// an unconfirmable ("unknown") outcome rather than left to hang the request indefinitely. Only
// this specific call gets a timeout — container creation and the processing poll above are safe
// to retry on any failure (nothing has been posted yet).
const SEND_TIMEOUT_MS = 20_000

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
 * threads account) — the actual API target user comes from THREADS_USER_ID, since a Threads
 * access token is already scoped to one user (never the account's username/handle — that would
 * not be a valid API user id), which is global across every project. Before anything else,
 * `projectSlug` must equal `THREADS_OWNER_PROJECT` — the one project allowed to use these global
 * credentials at all (see lib/social-account-ownership.ts for why `social_accounts.username`
 * alone, being user-editable and not unique across projects, cannot be that authorization). Once
 * that passes, this account's `username` is additionally compared against the username the
 * global credentials are actually connected to, as a second, independent sanity check; a
 * mismatch or a blank username still refuses to publish.
 *
 * Never re-sends an already-published publication, and never sends it twice concurrently: right
 * before threads_publish — the one irreversible "post it" call — `claimPublicationForSending`
 * atomically transitions the row to 'publishing' (see lib/social-publication-claim.ts); every
 * other caller (a concurrent click, the scheduler, a stuck row from a previous attempt) is refused
 * with 409 before threads_publish is ever called. Container creation and the processing poll
 * happen BEFORE the claim — nothing is posted yet at that point, so any failure there is safely a
 * normal, retriable 'failed'.
 *
 * threads_publish itself splits into two outcomes: a definitive Threads API rejection (a response
 * was received, just not a success one) is written to the row as status='failed'. A send whose
 * outcome is genuinely UNKNOWN — threads_publish's own fetch() never got a response at all (a
 * timeout, a dropped connection) — is deliberately NOT written as 'failed': the row is left at
 * 'publishing' and a 503 is returned instead, so it is never auto-retried either — only a human
 * who has checked Threads directly can resolve it. Unlike that one case, a permalink that can't be
 * read back is not treated as fatal (nor as "unknown") — the post itself already published
 * successfully by that point.
 */
export async function publishSocialPublicationToThreads(
  pool: Pool,
  id: string,
  projectSlug: string | null,
): Promise<SocialThreadsResult> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  // Authorization gate: the global credentials below belong to exactly one project. This must be
  // checked before anything else — social_accounts.username (checked further down) is
  // user-editable and not unique, so it cannot be the thing that decides this.
  const ownerProject = resolveOwnerProjectSlug(process.env.THREADS_OWNER_PROJECT)
  const projectGate = verifyProjectIsAllowed('Threads', 'THREADS_OWNER_PROJECT', ownerProject, projectSlug)
  if (!projectGate.ok) {
    await recordPublicationPreflightFailure(pool, id, projectId, projectGate.error)
    return { error: projectGate.error, status: 403 }
  }

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
    const error = 'only Threads publications can be published through this endpoint'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }
  if (publication.status === 'published') {
    return { error: 'this publication is already published', status: 409 }
  }

  let account: { platform?: string; active: boolean; username: string } | undefined
  if (publication.social_account_id) {
    const { rows } = await pool.query<{ platform: string; active: boolean; username: string }>(
      'SELECT platform, active, username FROM social_accounts WHERE id = $1 AND project_id = $2',
      [publication.social_account_id, projectId],
    )
    account = rows[0]
    if (!account || account.platform !== 'threads') {
      const error = 'linked account is not a Threads account'
      await recordPublicationPreflightFailure(pool, id, projectId, error)
      return { error, status: 400 }
    }
  } else {
    const { rows } = await pool.query<{ active: boolean; username: string }>(
      `SELECT active, username FROM social_accounts WHERE project_id = $1 AND platform = 'threads' AND active = true ORDER BY created_at ASC LIMIT 1`,
      [projectId],
    )
    account = rows[0]
  }
  if (!account) {
    const error = 'no Threads account configured for this project'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }
  if (!account.active) {
    const error = 'the linked Threads account is not active'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }

  const { rows: postRows } = await pool.query<{ threads_text: string; body: string }>(
    'SELECT threads_text, body FROM social_posts WHERE id = $1 AND project_id = $2',
    [publication.social_post_id, projectId],
  )
  const post = postRows[0]
  const text = resolveThreadsText(post?.threads_text, post?.body)
  if (!text) {
    const error = 'post has no content to publish'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }
  if (text.length > THREADS_TEXT_MAX_LENGTH) {
    const error = `Threads posts are limited to ${THREADS_TEXT_MAX_LENGTH} characters (this one is ${text.length})`
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }

  const userId = process.env.THREADS_USER_ID
  const token = process.env.THREADS_ACCESS_TOKEN
  if (!userId || !token) {
    const error = 'THREADS_ACCESS_TOKEN/THREADS_USER_ID is not configured on the server'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 500 }
  }

  // Ownership guard: the global credentials above are shared across every project. Confirm they
  // actually point at THIS project's Threads account before anything gets published — see
  // lib/social-account-ownership.ts.
  const identityParams = new URLSearchParams({ fields: 'username', access_token: token })
  const identityRes = await fetch(`${THREADS_API_BASE}/${userId}?${identityParams.toString()}`)
  const identityData = await identityRes.json().catch(() => null)
  if (!identityRes.ok || identityData?.error) {
    const error = (identityData?.error?.message as string) || `Threads API request failed (${identityRes.status})`
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 502 }
  }
  const ownership = compareAccountOwnership('Threads', account.username, identityData?.username as string | undefined)
  if (!ownership.ok) {
    await recordPublicationPreflightFailure(pool, id, projectId, ownership.error)
    return { error: ownership.error, status: 403 }
  }

  // Container creation + the processing poll happen before any claim — nothing is posted yet at
  // this point, so any failure here is always safely a normal, retriable 'failed'.
  let threadsError: string | null = null
  let containerId: string | undefined
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
      containerId = createData?.id as string | undefined
      if (!containerId) {
        threadsError = 'Threads did not return a media container id'
      } else {
        const finished = await waitForContainerFinished(containerId, token)
        if ('error' in finished) {
          threadsError = finished.error
          containerId = undefined
        }
      }
    }
  } catch (err) {
    threadsError = err instanceof Error ? err.message : String(err)
    containerId = undefined
  }

  if (!containerId) {
    const { rows } = await pool.query(
      `UPDATE social_publications SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND project_id = $3 RETURNING *`,
      [threadsError || 'Threads did not return a media container id', id, projectId],
    )
    return { row: rows[0] }
  }

  // Atomic claim, right before the one irreversible call — see claimPublicationForSending's own
  // comment. Container creation above never posts anything, so it's safe to redo on every retry;
  // only threads_publish actually matters.
  const claim = await claimPublicationForSending(pool, id, projectId)
  if (!claim.claimed) return publicationClaimConflictResult(claim.currentStatus)

  let mediaId: string | null = null
  let permalink: string | null = null
  let sendOutcomeUnknown = false
  try {
    const publishParams = new URLSearchParams({ creation_id: containerId, access_token: token })
    const publishRes = await fetch(`${THREADS_API_BASE}/${userId}/threads_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: publishParams.toString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    // A response was received — Threads definitively answered either way. But a 2xx status is
    // only a PARTIAL confirmation: if the body itself then fails to read (the connection drops
    // mid-stream), we genuinely don't know whether the post went out — a 2xx strongly suggests it
    // did, so this must NOT be treated as a confirmed failure (which would wrongly allow a retry
    // that could call threads_publish, and post the same content, a second time). A non-2xx
    // status is still a confirmed rejection regardless of whether its body can be read.
    let publishData: { error?: { message?: string }; id?: string } | null = null
    let bodyReadFailed = false
    try {
      publishData = await publishRes.json()
    } catch {
      bodyReadFailed = true
    }
    if (publishRes.ok && bodyReadFailed) {
      threadsError = 'Threads returned a success status but the response body could not be read'
      sendOutcomeUnknown = true
    } else if (!publishRes.ok || publishData?.error) {
      threadsError = publishData?.error?.message || `Threads API request failed (${publishRes.status})`
    } else {
      mediaId = (publishData?.id as string) || null
      if (!mediaId) {
        threadsError = 'Threads did not return a published post id'
      } else {
        // Best-effort only: the post already published successfully above, so a permalink
        // lookup failure here must not turn a successful publish into a reported failure.
        try {
          const permaParams = new URLSearchParams({ fields: 'permalink', access_token: token })
          const permaRes = await fetch(`${THREADS_API_BASE}/${mediaId}?${permaParams.toString()}`)
          const permaData = await permaRes.json().catch(() => null)
          if (permaRes.ok && !permaData?.error) {
            permalink = (permaData?.permalink as string) || null
          }
        } catch {
          // Best-effort — a network failure here doesn't change anything either (mediaId is
          // already set, so the outcome below is 'published' regardless).
        }
      }
    }
  } catch (err) {
    // fetch() itself threw on threads_publish specifically — a timeout (AbortSignal above) or a
    // dropped connection. Threads never sent a response at all, so the content may or may not have
    // actually been posted. Not a confirmed failure.
    threadsError = err instanceof Error ? err.message : String(err)
    sendOutcomeUnknown = true
  }

  if (sendOutcomeUnknown) {
    // Deliberately no DB write — the row stays 'publishing' from the claim above.
    return {
      error: `Could not confirm whether Threads received the publish request: ${threadsError}. The publication is left as "publishing" — check Threads directly before retrying manually.`,
      status: 503,
    }
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
