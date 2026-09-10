import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getSocialPost, isSocialChannel } from '@/lib/social'

const KNOWN_STATUSES = ['draft', 'ready', 'published', 'failed'] as const
export type SocialPublicationStatus = (typeof KNOWN_STATUSES)[number]

export function isSocialPublicationStatus(value: unknown): value is SocialPublicationStatus {
  return typeof value === 'string' && (KNOWN_STATUSES as readonly string[]).includes(value)
}

export type SocialPublicationPatch = {
  socialAccountId?: string | null
  status?: string
  externalUrl?: string
  externalPostId?: string
  error?: string
}

export type SocialPublicationResult = { error: string; status: number } | { row: Record<string, unknown> }

/** All operations are project-scoped: every query filters by project_id, resolved from the
 * caller-supplied slug — a publication id from another project can never be read or edited by
 * supplying a different id with this project's slug (or vice versa), and a social_account_id
 * can only be attached if that account belongs to the same project. */

/** Ensures one social_publications row exists per channel currently selected on the post
 * (idempotent — a channel already tracked is never duplicated), then returns every publication
 * recorded for the post, including ones for channels since removed from it. Returns null if the
 * project or post can't be resolved. */
export async function listPublicationsForPost(
  postId: string,
  projectSlug: string | null,
): Promise<Record<string, unknown>[] | null> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return null

  const post = await getSocialPost(postId, projectSlug)
  if (!post) return null

  const channels = typeof post.channels === 'string' ? post.channels.split(',').filter(isSocialChannel) : []

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

  const { rows } = await pool.query(
    'SELECT * FROM social_publications WHERE social_post_id = $1 AND project_id = $2 ORDER BY created_at ASC',
    [postId, projectId],
  )
  return rows
}

export async function updateSocialPublication(
  id: string,
  projectSlug: string | null,
  input: SocialPublicationPatch,
): Promise<SocialPublicationResult> {
  if (input.status && !isSocialPublicationStatus(input.status)) return { error: 'invalid status', status: 400 }

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

  if (input.socialAccountId !== undefined) {
    if (input.socialAccountId !== null) {
      const { rows: accountRows } = await pool.query(
        'SELECT id FROM social_accounts WHERE id = $1 AND project_id = $2',
        [input.socialAccountId, projectId],
      )
      if (!accountRows[0]) return { error: 'account not found in this project', status: 400 }
    }
    set('social_account_id', input.socialAccountId)
  }
  if (typeof input.externalUrl === 'string') set('external_url', input.externalUrl.trim())
  if (typeof input.externalPostId === 'string') set('external_post_id', input.externalPostId.trim())
  if (typeof input.error === 'string') set('error', input.error)
  if (input.status) {
    set('status', input.status)
    sets.push(input.status === 'published' ? 'published_at = coalesce(published_at, now())' : 'published_at = NULL')
  }

  if (!sets.length) {
    const { rows } = await pool.query('SELECT * FROM social_publications WHERE id = $1 AND project_id = $2', [
      id,
      projectId,
    ])
    if (!rows[0]) return { error: 'not found', status: 404 }
    return { row: rows[0] }
  }

  sets.push('updated_at = now()')
  params.push(id, projectId)

  const { rows } = await pool.query(
    `UPDATE social_publications SET ${sets.join(', ')} WHERE id = $${i} AND project_id = $${i + 1} RETURNING *`,
    params,
  )
  if (!rows[0]) return { error: 'not found', status: 404 }
  return { row: rows[0] }
}
