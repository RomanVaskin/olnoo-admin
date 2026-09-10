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

function serializeChannels(channels: string[]): string {
  return channels.filter(isSocialChannel).join(',')
}

export type SocialPostFields = {
  topic: string
  category?: string
  body?: string
  telegramText?: string
  instagramText?: string
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

  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const id = randomUUID()
  const { rows } = await pool.query(
    `
    INSERT INTO social_posts (
      id, project_id, topic, category, body, telegram_text, instagram_text, threads_text, vk_text,
      channels, publish_date, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      input.threadsText ?? '',
      input.vkText ?? '',
      serializeChannels(input.channels ?? []),
      (input.publishDate ?? '').trim(),
      input.status ?? 'idea',
    ],
  )
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
  if (typeof input.threadsText === 'string') set('threads_text', input.threadsText)
  if (typeof input.vkText === 'string') set('vk_text', input.vkText)
  if (input.channels) set('channels', serializeChannels(input.channels))
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
  return { row: rows[0] }
}

export async function deleteSocialPost(id: string, projectSlug: string | null): Promise<boolean> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return false
  const { rowCount } = await pool.query('DELETE FROM social_posts WHERE id = $1 AND project_id = $2', [id, projectId])
  return (rowCount ?? 0) > 0
}
