import type { Pool } from 'pg'
import { resolveProjectId } from '@/lib/crm'
import { syncPostStatusFromPublications } from '@/lib/social'
import { compareAccountOwnership, resolveOwnerProjectSlug, verifyProjectIsAllowed } from '@/lib/social-account-ownership'
import { decryptAccountSecret } from '@/lib/social-account-crypto'
import { recordPublicationPreflightFailure } from '@/lib/social-publication-preflight-failure'
import { resolveInstagramPublishOutcome } from '@/lib/social-instagram-publish-outcome'
import { claimPublicationForSending, publicationClaimConflictResult } from '@/lib/social-publication-claim'

// Server-side only. Credentials must never be sent to the browser — they are read here and only
// here, inside a function called exclusively from a server route handler.
//
// Two credential sources, tried in this order (Social Connect MVP — see
// db/migrations/0022_social_accounts_meta_credentials.sql):
//   1. The linked social_accounts row's OWN encrypted token (instagram_access_token_encrypted +
//      instagram_account_id), connected per-project via lib/social-accounts-instagram-connection.ts
//      — same model VK already uses (lib/social-vk.ts). Scoped to this project by construction:
//      the account row is only ever read with `WHERE project_id = $2`, so there is no way for one
//      project to resolve another project's per-account token.
//   2. If the account has no per-account token, the original global env fallback: an Instagram
//      Login access token is already scoped to one specific account, so INSTAGRAM_ACCESS_TOKEN/
//      INSTAGRAM_ACCOUNT_ID are global across every project, and INSTAGRAM_OWNER_PROJECT names the
//      one project allowed to use them at all — unchanged from before this MVP, kept so OLNOO
//      itself never loses the ability to publish while it migrates to its own per-account
//      connection. `social_accounts.username` is additionally compared against the global
//      credential's actual handle as a second, independent sanity check; neither check is, by
//      itself, sufficient — see lib/social-account-ownership.ts for why.

export type SocialInstagramResult = { error: string; status: number } | { row: Record<string, unknown> }

// Overridable the same way TELEGRAM_API_BASE_URL/VK_API_BASE_URL override their own base URLs —
// not a secret, just lets a non-production environment point at a mock Instagram API.
const IG_API_BASE = process.env.INSTAGRAM_API_BASE_URL || 'https://graph.instagram.com'

const CONTAINER_POLL_MAX_ATTEMPTS = 5
const CONTAINER_POLL_DELAY_MS = 1500

// Bounds how long the one, irreversible media_publish call may hang before this is treated as an
// unconfirmable ("unknown") outcome rather than left to hang the request indefinitely. Only this
// specific call gets a timeout — container creation and the processing poll above are safe to
// retry on any failure (nothing has been posted yet).
const SEND_TIMEOUT_MS = 20_000

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
 * instagram account) — the actual API target account comes from INSTAGRAM_ACCOUNT_ID, since an
 * Instagram Login token is already scoped to one account, which is global across every project.
 * Before anything else, `projectSlug` must equal `INSTAGRAM_OWNER_PROJECT` — the one project
 * allowed to use these global credentials at all (see lib/social-account-ownership.ts for why
 * `social_accounts.username` alone, being user-editable and not unique across projects, cannot
 * be that authorization). Once that passes, this account's `username` is additionally compared
 * against the username the global credentials are actually connected to, as a second,
 * independent sanity check; a mismatch or a blank username still refuses to publish.
 *
 * Never re-sends an already-published publication, and never sends it twice concurrently: right
 * before media_publish — the one irreversible "post it" call — `claimPublicationForSending`
 * atomically transitions the row to 'publishing' (see lib/social-publication-claim.ts); every
 * other caller (a concurrent click, the scheduler, a stuck row from a previous attempt) is refused
 * with 409 before media_publish is ever called. Container creation and the processing poll happen
 * BEFORE the claim — nothing is posted yet at that point, so any failure there (an Instagram API
 * error, a failed/expired container, or a network failure) is safely a normal, retriable 'failed'.
 *
 * media_publish itself splits into two outcomes: a definitive Instagram API rejection (a response
 * was received, just not a success one) is written to the row as status='failed'. A send whose
 * outcome is genuinely UNKNOWN — media_publish's own fetch() never got a response at all (a
 * timeout, a dropped connection) — is deliberately NOT written as 'failed': the content may or may
 * not have actually been posted, so the row is left at 'publishing' and a 503 is returned instead,
 * so it is never auto-retried either — only a human who has checked Instagram directly can resolve
 * it (see resolveInstagramPublishOutcome for the exact decision).
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
    const error = 'only Instagram publications can be published through this endpoint'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }
  if (publication.status === 'published') {
    return { error: 'this publication is already published', status: 409 }
  }

  type InstagramAccountRow = {
    platform?: string
    active: boolean
    username: string
    instagram_access_token_encrypted: string
    instagram_account_id: string
    instagram_token_expires_at: string | null
  }
  let account: InstagramAccountRow | undefined
  if (publication.social_account_id) {
    const { rows } = await pool.query<InstagramAccountRow>(
      'SELECT platform, active, username, instagram_access_token_encrypted, instagram_account_id, instagram_token_expires_at FROM social_accounts WHERE id = $1 AND project_id = $2',
      [publication.social_account_id, projectId],
    )
    account = rows[0]
    if (!account || account.platform !== 'instagram') {
      const error = 'linked account is not an Instagram account'
      await recordPublicationPreflightFailure(pool, id, projectId, error)
      return { error, status: 400 }
    }
  } else {
    const { rows } = await pool.query<InstagramAccountRow>(
      `SELECT active, username, instagram_access_token_encrypted, instagram_account_id, instagram_token_expires_at
       FROM social_accounts WHERE project_id = $1 AND platform = 'instagram' AND active = true ORDER BY created_at ASC LIMIT 1`,
      [projectId],
    )
    account = rows[0]
  }
  if (!account) {
    const error = 'no Instagram account configured for this project'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }
  if (!account.active) {
    const error = 'the linked Instagram account is not active'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }

  const { rows: postRows } = await pool.query<{ instagram_text: string; body: string; instagram_image_url: string }>(
    'SELECT instagram_text, body, instagram_image_url FROM social_posts WHERE id = $1 AND project_id = $2',
    [publication.social_post_id, projectId],
  )
  const post = postRows[0]
  const caption = post?.instagram_text?.trim() || post?.body?.trim() || ''
  if (!caption) {
    const error = 'post has no content to publish'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }
  const imageUrl = post?.instagram_image_url?.trim() || ''
  if (!imageUrl) {
    const error = 'post has no Instagram image URL to publish'
    await recordPublicationPreflightFailure(pool, id, projectId, error)
    return { error, status: 400 }
  }

  let accountId: string
  let token: string
  if (account.instagram_access_token_encrypted) {
    // Per-account credential: scoped to this project already (the account row above was read
    // with `WHERE project_id = $2`), so no ownership check is needed — unlike the global
    // fallback, this token was never shared with any other project to begin with.
    if (account.instagram_token_expires_at && new Date(account.instagram_token_expires_at) <= new Date()) {
      const error =
        'This Instagram account\'s access token has expired. Reconnect it in Social → Accounts (the token could not be ' +
        'refreshed automatically — see lib/social-accounts-instagram-connection.ts for why refresh is only attempted on an explicit recheck).'
      await recordPublicationPreflightFailure(pool, id, projectId, error)
      return { error, status: 403 }
    }
    try {
      token = decryptAccountSecret(account.instagram_access_token_encrypted)
    } catch (err) {
      const error = `Could not decrypt the stored Instagram token: ${err instanceof Error ? err.message : String(err)}`
      await recordPublicationPreflightFailure(pool, id, projectId, error)
      return { error, status: 500 }
    }
    accountId = account.instagram_account_id
  } else {
    // Global env fallback — unchanged from before this MVP, still gated by INSTAGRAM_OWNER_PROJECT
    // so it can never be used to publish into another project's account. See
    // lib/social-account-ownership.ts for why this gate (not social_accounts.username alone) is
    // the actual authorization.
    const ownerProject = resolveOwnerProjectSlug(process.env.INSTAGRAM_OWNER_PROJECT)
    const projectGate = verifyProjectIsAllowed('Instagram', 'INSTAGRAM_OWNER_PROJECT', ownerProject, projectSlug)
    if (!projectGate.ok) {
      await recordPublicationPreflightFailure(pool, id, projectId, projectGate.error)
      return { error: projectGate.error, status: 403 }
    }

    const envAccountId = process.env.INSTAGRAM_ACCOUNT_ID
    const envToken = process.env.INSTAGRAM_ACCESS_TOKEN
    if (!envAccountId || !envToken) {
      const error = 'INSTAGRAM_ACCESS_TOKEN/INSTAGRAM_ACCOUNT_ID is not configured on the server'
      await recordPublicationPreflightFailure(pool, id, projectId, error)
      return { error, status: 500 }
    }

    // Ownership guard: the global credentials above are shared across every project. Confirm they
    // actually point at THIS project's Instagram account before anything gets published — see
    // lib/social-account-ownership.ts.
    const identityParams = new URLSearchParams({ fields: 'username', access_token: envToken })
    const identityRes = await fetch(`${IG_API_BASE}/${envAccountId}?${identityParams.toString()}`)
    const identityData = await identityRes.json().catch(() => null)
    if (!identityRes.ok || identityData?.error) {
      const error = (identityData?.error?.message as string) || `Instagram API request failed (${identityRes.status})`
      await recordPublicationPreflightFailure(pool, id, projectId, error)
      return { error, status: 502 }
    }
    const ownership = compareAccountOwnership('Instagram', account.username, identityData?.username as string | undefined)
    if (!ownership.ok) {
      await recordPublicationPreflightFailure(pool, id, projectId, ownership.error)
      return { error: ownership.error, status: 403 }
    }

    accountId = envAccountId
    token = envToken
  }

  // Container creation + the processing poll happen before any claim — nothing is posted yet at
  // this point, so any failure here (a definitive Instagram rejection, an expired/errored
  // container, or a network failure) is always safely a normal, retriable 'failed'.
  let igError: string | null = null
  let containerId: string | undefined
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
      containerId = createData?.id as string | undefined
      if (!containerId) {
        igError = 'Instagram did not return a media container id'
      } else {
        const finished = await waitForContainerFinished(containerId, token)
        if ('error' in finished) {
          igError = finished.error
          containerId = undefined
        }
      }
    }
  } catch (err) {
    igError = err instanceof Error ? err.message : String(err)
    containerId = undefined
  }

  if (!containerId) {
    const { rows } = await pool.query(
      `UPDATE social_publications SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND project_id = $3 RETURNING *`,
      [igError || 'Instagram did not return a media container id', id, projectId],
    )
    return { row: rows[0] }
  }

  // Atomic claim, right before the one irreversible call — see claimPublicationForSending's own
  // comment. Container creation above never posts anything, so it's safe to redo on every retry;
  // only media_publish actually matters.
  const claim = await claimPublicationForSending(pool, id, projectId)
  if (!claim.claimed) return publicationClaimConflictResult(claim.currentStatus)

  let mediaId: string | null = null
  let permalink: string | null = null
  let sendOutcomeUnknown = false
  try {
    const publishParams = new URLSearchParams({ creation_id: containerId, access_token: token })
    const publishRes = await fetch(`${IG_API_BASE}/${accountId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: publishParams.toString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    // A response was received — Instagram definitively answered either way. But a 2xx status is
    // only a PARTIAL confirmation: if the body itself then fails to read (the connection drops
    // mid-stream), we genuinely don't know whether the post went out — a 2xx strongly suggests it
    // did, so this must NOT be treated as a confirmed failure (which would wrongly allow a retry
    // that could call media_publish, and post the same content, a second time). A non-2xx status
    // is still a confirmed rejection regardless of whether its body can be read.
    let publishData: { error?: { message?: string }; id?: string } | null = null
    let bodyReadFailed = false
    try {
      publishData = await publishRes.json()
    } catch {
      bodyReadFailed = true
    }
    if (publishRes.ok && bodyReadFailed) {
      igError = 'Instagram returned a success status but the response body could not be read'
      sendOutcomeUnknown = true
    } else if (!publishRes.ok || publishData?.error) {
      igError = publishData?.error?.message || `Instagram API request failed (${publishRes.status})`
    } else {
      mediaId = (publishData?.id as string) || null
      if (!mediaId) {
        igError = 'Instagram did not return a published media id'
      } else {
        // Best-effort only: media_publish above already succeeded, so the post is already live on
        // Instagram — a permalink lookup failure here must not turn that into a reported failure
        // (see resolveInstagramPublishOutcome for why: a 'failed' row would no longer trip the
        // "already published" 409 guard, so a retry would call media_publish a second time and
        // create a duplicate post).
        try {
          const permaParams = new URLSearchParams({ fields: 'permalink', access_token: token })
          const permaRes = await fetch(`${IG_API_BASE}/${mediaId}?${permaParams.toString()}`)
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
    // fetch() itself threw on media_publish specifically — a timeout (AbortSignal above) or a
    // dropped connection. Instagram never sent a response at all, so the content may or may not
    // have actually been posted. Not a confirmed failure.
    igError = err instanceof Error ? err.message : String(err)
    sendOutcomeUnknown = true
  }

  const outcome = resolveInstagramPublishOutcome(mediaId, permalink, igError, sendOutcomeUnknown)

  if (outcome.status === 'unknown') {
    // Deliberately no DB write — the row stays 'publishing' from the claim above.
    return {
      error: `Could not confirm whether Instagram received the publish request: ${outcome.error}. The publication is left as "publishing" — check Instagram directly before retrying manually.`,
      status: 503,
    }
  }

  if (outcome.status === 'failed') {
    const { rows } = await pool.query(
      `UPDATE social_publications SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND project_id = $3 RETURNING *`,
      [outcome.error, id, projectId],
    )
    return { row: rows[0] }
  }

  const { rows } = await pool.query(
    `UPDATE social_publications
     SET status = 'published', external_post_id = $1, external_url = $2, error = '',
         published_at = coalesce(published_at, now()), updated_at = now()
     WHERE id = $3 AND project_id = $4 RETURNING *`,
    [outcome.externalPostId, outcome.externalUrl, id, projectId],
  )
  await syncPostStatusFromPublications(publication.social_post_id, projectId)
  return { row: rows[0] }
}
