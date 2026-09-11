import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'

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

export async function listSocialPosts(
  projectSlug: string | null,
  filters: { q?: string; status?: string } = {},
): Promise<Record<string, unknown>[] | null> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return null

  const clauses = ['project_id = $1']
  const params: unknown[] = [projectId]

  const q = filters.q?.trim()
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    clauses.push(`(topic ILIKE $${params.length} ESCAPE '\\' OR category ILIKE $${params.length} ESCAPE '\\')`)
  }
  if (filters.status && isSocialStatus(filters.status)) {
    params.push(filters.status)
    clauses.push(`status = $${params.length}`)
  }

  const { rows } = await pool.query(
    `SELECT * FROM social_posts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
    params,
  )
  return rows
}

export async function getSocialPost(id: string, projectSlug: string | null): Promise<Record<string, unknown> | null> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return null
  const { rows } = await pool.query('SELECT * FROM social_posts WHERE id = $1 AND project_id = $2', [id, projectId])
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

  return { row: rows[0] }
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

  return { row: rows[0] }
}

export async function deleteSocialPost(id: string, projectSlug: string | null): Promise<boolean> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return false
  const { rowCount } = await pool.query('DELETE FROM social_posts WHERE id = $1 AND project_id = $2', [id, projectId])
  return (rowCount ?? 0) > 0
}
