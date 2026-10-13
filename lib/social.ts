import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { resolveLeadsProjectFilter, wantsAllProjects } from '@/lib/leads-project-filter'

const KNOWN_STATUSES = ['idea', 'draft', 'ready', 'published'] as const
export type SocialStatus = (typeof KNOWN_STATUSES)[number]

export function isSocialStatus(value: unknown): value is SocialStatus {
  return typeof value === 'string' && (KNOWN_STATUSES as readonly string[]).includes(value)
}

const KNOWN_CHANNELS = ['telegram', 'instagram', 'threads', 'vk'] as const
export type SocialChannel = (typeof KNOWN_CHANNELS)[number]

export function isSocialChannel(value: unknown): value is SocialChannel {
  return typeof value === 'string' && (KNOWN_CHANNELS as readonly string[]).includes(value)
}

/** The channels currently stored for a post, parsed and filtered to known values. Used when an
 * update doesn't touch channels itself but still needs to know the post's effective channel set
 * (the "published" guard in updateSocialPost). */
async function getStoredChannels(id: string, projectSlug: string | null): Promise<SocialChannel[]> {
  const existing = await getSocialPost(id, projectSlug)
  const raw = typeof existing?.channels === 'string' ? existing.channels : ''
  return raw.split(',').filter(isSocialChannel)
}

/** Inserts a draft social_publications row for each of the given channels that doesn't already
 * have one for this post (idempotent — never duplicates a channel already tracked). Channels no
 * longer selected keep their existing row rather than having it removed. This is the only place
 * a publication row gets created — always as a side effect of the post's channels being set,
 * never from a read path. */
async function ensurePublicationsForChannels(
  postId: string,
  projectId: number,
  channels: SocialChannel[],
): Promise<void> {
  if (channels.length === 0) return

  const { rows: existing } = await pool.query<{ platform: string }>(
    'SELECT platform FROM social_publications WHERE social_post_id = $1 AND project_id = $2',
    [postId, projectId],
  )
  const existingPlatforms = new Set(existing.map((row) => row.platform))

  for (const platform of channels) {
    if (existingPlatforms.has(platform)) continue
    await pool.query(
      `INSERT INTO social_publications (id, project_id, social_post_id, platform, status)
       VALUES ($1, $2, $3, $4, 'draft')`,
      [randomUUID(), projectId, postId, platform],
    )
  }
}

/** Whether every one of the given channels currently has a 'published' social_publications row
 * for this post — the one fact social_posts.status is ever allowed to reflect as "published". */
async function isFullyPublished(postId: string, projectId: number, channels: SocialChannel[]): Promise<boolean> {
  if (channels.length === 0) return false
  const { rows } = await pool.query<{ platform: string; status: string }>(
    'SELECT platform, status FROM social_publications WHERE social_post_id = $1 AND project_id = $2',
    [postId, projectId],
  )
  const statusByPlatform = new Map(rows.map((row) => [row.platform, row.status]))
  return channels.every((channel) => statusByPlatform.get(channel) === 'published')
}

/**
 * Keeps social_posts.status honest against social_publications — the only source of truth for
 * "is this post actually published". Never part of a read path: call this only after an
 * operation that actually changes state — a publication created, updated, or deleted (see
 * lib/social-publications.ts), or the post's own selected channels changing (see
 * updateSocialPost/createSocialPost below). A post's status becomes 'published' only once every
 * currently selected channel has a 'published' publication; the moment that stops holding, it's
 * demoted back to 'ready' rather than left claiming a state that no longer holds. A post with no
 * channels selected is left alone. Idempotent.
 */
export async function syncPostStatusFromPublications(postId: string, projectId: number): Promise<void> {
  const { rows: postRows } = await pool.query<{ channels: string; status: string }>(
    'SELECT channels, status FROM social_posts WHERE id = $1 AND project_id = $2',
    [postId, projectId],
  )
  const post = postRows[0]
  if (!post) return

  const channels = post.channels ? post.channels.split(',').filter(isSocialChannel) : []
  if (channels.length === 0) return

  const fullyPublished = await isFullyPublished(postId, projectId, channels)
  if (fullyPublished && post.status !== 'published') {
    await pool.query('UPDATE social_posts SET status = $1, updated_at = now() WHERE id = $2 AND project_id = $3', [
      'published',
      postId,
      projectId,
    ])
  } else if (!fullyPublished && post.status === 'published') {
    await pool.query('UPDATE social_posts SET status = $1, updated_at = now() WHERE id = $2 AND project_id = $3', [
      'ready',
      postId,
      projectId,
    ])
  }
}

export type SocialPostFields = {
  topic: string
  category?: string
  body?: string
  telegramText?: string
  instagramText?: string
  instagramImageUrl?: string
  threadsText?: string
  vkText?: string
  channels?: string[]
  publishDate?: string
  status?: string
}

export type SocialResult = { error: string; status: number } | { row: Record<string, unknown> }

/** All operations are project-scoped: every query filters by project_id, resolved from the
 * caller-supplied slug — a post id from another project can never be read, edited, or deleted
 * by supplying a different id with this project's slug (or vice versa). */

/**
 * `projectSlug` of `null`/`''`/`'all'` lists posts across every project (the Social "All projects"
 * mode) — each row carries its own `project_slug`/`project_name` (joined from `projects`, same
 * pattern as `LEADS_SELECT` in app/api/leads/route.ts and lib/social-overview.ts) so the UI can
 * show a Project column and know which project to scope a later edit/delete/publish to. A real
 * slug scopes to that one project as before. An unresolved slug returns `null` (never silently
 * falls back to "all") — reuses lib/leads-project-filter.ts's `wantsAllProjects`/
 * `resolveLeadsProjectFilter` rather than re-deciding the same fail-closed rule again.
 */
export async function listSocialPosts(
  projectSlug: string | null,
  filters: { q?: string; status?: string } = {},
): Promise<Record<string, unknown>[] | null> {
  const resolvedProjectId = wantsAllProjects(projectSlug) ? null : await resolveProjectId(projectSlug)
  const filter = resolveLeadsProjectFilter(projectSlug, resolvedProjectId)
  if (filter.kind === 'none') return null

  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.kind === 'one') {
    params.push(filter.projectId)
    clauses.push(`sp.project_id = $${params.length}`)
  }

  const q = filters.q?.trim()
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    clauses.push(`(sp.topic ILIKE $${params.length} ESCAPE '\\' OR sp.category ILIKE $${params.length} ESCAPE '\\')`)
  }
  if (filters.status && isSocialStatus(filters.status)) {
    params.push(filters.status)
    clauses.push(`sp.status = $${params.length}`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const { rows } = await pool.query(
    `SELECT sp.*, p.slug AS project_slug, p.name AS project_name
     FROM social_posts sp
     JOIN projects p ON p.id = sp.project_id
     ${where}
     ORDER BY sp.created_at DESC`,
    params,
  )
  return rows
}

/**
 * Always includes `project_slug`/`project_name` (joined from `projects`, same as
 * `listSocialPosts`) — not just for the "all projects" list. `createSocialPost`/`updateSocialPost`
 * route their own return value through this function rather than their own bare `RETURNING *`, so
 * every post the client ever receives — freshly created, just edited, or re-fetched — carries its
 * own project slug consistently. Without that, a freshly created/edited post's client-side object
 * would have an empty `projectSlug` until the next full list refetch, and any further per-row
 * action scoped to that project (editing, deleting, Instagram image upload, generate-variants,
 * publishing) would send `project=` (empty) and fail with "a known project is required" even
 * though the admin had already picked a real project to create/edit it under.
 */
export async function getSocialPost(id: string, projectSlug: string | null): Promise<Record<string, unknown> | null> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return null
  const { rows } = await pool.query(
    `SELECT sp.*, p.slug AS project_slug, p.name AS project_name
     FROM social_posts sp
     JOIN projects p ON p.id = sp.project_id
     WHERE sp.id = $1 AND sp.project_id = $2`,
    [id, projectId],
  )
  return rows[0] ?? null
}

export async function createSocialPost(projectSlug: string | null, input: SocialPostFields): Promise<SocialResult> {
  if (!input.topic.trim()) return { error: 'topic is required', status: 400 }
  if (input.status && !isSocialStatus(input.status)) return { error: 'invalid status', status: 400 }
  // A brand-new post can never have a publication yet, so it can never legitimately start out
  // published — no query needed to know that.
  if (input.status === 'published') {
    return { error: 'a new post cannot be created already published', status: 400 }
  }

  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const id = randomUUID()
  const channels = (input.channels ?? []).filter(isSocialChannel)
  const { rows } = await pool.query(
    `
    INSERT INTO social_posts (
      id, project_id, topic, category, body, telegram_text, instagram_text, instagram_image_url,
      threads_text, vk_text, channels, publish_date, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *
    `,
    [
      id,
      projectId,
      input.topic.trim(),
      (input.category ?? '').trim(),
      input.body ?? '',
      input.telegramText ?? '',
      input.instagramText ?? '',
      input.instagramImageUrl ?? '',
      input.threadsText ?? '',
      input.vkText ?? '',
      channels.join(','),
      (input.publishDate ?? '').trim(),
      input.status ?? 'idea',
    ],
  )

  if (channels.length > 0) {
    await ensurePublicationsForChannels(id, projectId, channels)
  }

  // Re-read through getSocialPost (not the bare `rows[0]` from RETURNING *) so the row handed
  // back to the caller already carries project_slug/project_name — see getSocialPost's own
  // comment for why this matters. projectId was just resolved above, so this is guaranteed to
  // find the row just inserted.
  const created = await getSocialPost(id, projectSlug)
  return { row: created ?? rows[0] }
}

export async function updateSocialPost(
  id: string,
  projectSlug: string | null,
  input: Partial<SocialPostFields>,
): Promise<SocialResult> {
  if (typeof input.topic === 'string' && !input.topic.trim()) {
    return { error: 'topic is required', status: 400 }
  }
  if (input.status && !isSocialStatus(input.status)) return { error: 'invalid status', status: 400 }

  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  // The channels this update will leave the post with — from this same patch if it's changing
  // them, otherwise whatever's already stored. Resolved once, used both by the "published" guard
  // below and by the post-write reconciliation.
  const nextChannels = input.channels ? input.channels.filter(isSocialChannel) : null

  if (input.status === 'published') {
    const channelsToCheck = nextChannels ?? (await getStoredChannels(id, projectSlug))
    if (!(await isFullyPublished(id, projectId, channelsToCheck))) {
      return {
        error: 'post cannot be marked published until every selected channel has a published publication',
        status: 400,
      }
    }
  }

  const sets: string[] = []
  const params: unknown[] = []
  let i = 1

  function set(column: string, value: unknown) {
    sets.push(`${column} = $${i}`)
    params.push(value)
    i++
  }

  if (typeof input.topic === 'string') set('topic', input.topic.trim())
  if (typeof input.category === 'string') set('category', input.category.trim())
  if (typeof input.body === 'string') set('body', input.body)
  if (typeof input.telegramText === 'string') set('telegram_text', input.telegramText)
  if (typeof input.instagramText === 'string') set('instagram_text', input.instagramText)
  if (typeof input.instagramImageUrl === 'string') set('instagram_image_url', input.instagramImageUrl.trim())
  if (typeof input.threadsText === 'string') set('threads_text', input.threadsText)
  if (typeof input.vkText === 'string') set('vk_text', input.vkText)
  if (nextChannels) set('channels', nextChannels.join(','))
  if (typeof input.publishDate === 'string') set('publish_date', input.publishDate.trim())
  if (input.status) set('status', input.status)

  if (!sets.length) {
    const existing = await getSocialPost(id, projectSlug)
    if (!existing) return { error: 'not found', status: 404 }
    return { row: existing }
  }

  sets.push('updated_at = now()')
  params.push(id, projectId)

  const { rows } = await pool.query(
    `UPDATE social_posts SET ${sets.join(', ')} WHERE id = $${i} AND project_id = $${i + 1} RETURNING *`,
    params,
  )
  if (!rows[0]) return { error: 'not found', status: 404 }

  if (nextChannels) {
    await ensurePublicationsForChannels(id, projectId, nextChannels)
    await syncPostStatusFromPublications(id, projectId)
    // The reconciliation above may have just changed status again (e.g. dropping the one
    // channel that wasn't published yet just made the rest fully published) — re-read so the
    // caller never sees the pre-reconciliation snapshot.
    const fresh = await getSocialPost(id, projectSlug)
    if (fresh) return { row: fresh }
  }

  // Same reasoning as createSocialPost: re-read through getSocialPost rather than returning the
  // bare `rows[0]` from RETURNING *, so this row also carries project_slug/project_name.
  const updated = await getSocialPost(id, projectSlug)
  return { row: updated ?? rows[0] }
}

export async function deleteSocialPost(id: string, projectSlug: string | null): Promise<boolean> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return false
  const { rowCount } = await pool.query('DELETE FROM social_posts WHERE id = $1 AND project_id = $2', [id, projectId])
  return (rowCount ?? 0) > 0
}
