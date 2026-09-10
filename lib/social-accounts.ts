import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { isSocialChannel } from '@/lib/social'

const KNOWN_STATUSES = ['created', 'connected'] as const
export type SocialAccountStatus = (typeof KNOWN_STATUSES)[number]

export function isSocialAccountStatus(value: unknown): value is SocialAccountStatus {
  return typeof value === 'string' && (KNOWN_STATUSES as readonly string[]).includes(value)
}

export type SocialAccountFields = {
  platform: string
  name?: string
  username?: string
  publicUrl?: string
  status?: string
  active?: boolean
  notes?: string
}

export type SocialAccountResult = { error: string; status: number } | { row: Record<string, unknown> }

/** All operations are project-scoped: every query filters by project_id, resolved from the
 * caller-supplied slug — an account id from another project can never be read, edited, or
 * deleted by supplying a different id with this project's slug (or vice versa). */

export async function listSocialAccounts(
  projectSlug: string | null,
  filters: { platform?: string } = {},
): Promise<Record<string, unknown>[] | null> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return null

  const clauses = ['project_id = $1']
  const params: unknown[] = [projectId]

  if (filters.platform && isSocialChannel(filters.platform)) {
    params.push(filters.platform)
    clauses.push(`platform = $${params.length}`)
  }

  const { rows } = await pool.query(
    `SELECT * FROM social_accounts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
    params,
  )
  return rows
}

export async function getSocialAccount(
  id: string,
  projectSlug: string | null,
): Promise<Record<string, unknown> | null> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return null
  const { rows } = await pool.query('SELECT * FROM social_accounts WHERE id = $1 AND project_id = $2', [id, projectId])
  return rows[0] ?? null
}

export async function createSocialAccount(
  projectSlug: string | null,
  input: SocialAccountFields,
): Promise<SocialAccountResult> {
  if (!isSocialChannel(input.platform)) return { error: 'a known platform is required', status: 400 }
  if (input.status && !isSocialAccountStatus(input.status)) return { error: 'invalid status', status: 400 }

  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const id = randomUUID()
  const { rows } = await pool.query(
    `
    INSERT INTO social_accounts (
      id, project_id, platform, name, username, public_url, status, active, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
    `,
    [
      id,
      projectId,
      input.platform,
      (input.name ?? '').trim(),
      (input.username ?? '').trim(),
      (input.publicUrl ?? '').trim(),
      input.status ?? 'created',
      input.active ?? true,
      input.notes ?? '',
    ],
  )
  return { row: rows[0] }
}

export async function updateSocialAccount(
  id: string,
  projectSlug: string | null,
  input: Partial<SocialAccountFields>,
): Promise<SocialAccountResult> {
  if (input.platform !== undefined && !isSocialChannel(input.platform)) {
    return { error: 'a known platform is required', status: 400 }
  }
  if (input.status && !isSocialAccountStatus(input.status)) return { error: 'invalid status', status: 400 }

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

  if (input.platform !== undefined) set('platform', input.platform)
  if (typeof input.name === 'string') set('name', input.name.trim())
  if (typeof input.username === 'string') set('username', input.username.trim())
  if (typeof input.publicUrl === 'string') set('public_url', input.publicUrl.trim())
  if (input.status) set('status', input.status)
  if (typeof input.active === 'boolean') set('active', input.active)
  if (typeof input.notes === 'string') set('notes', input.notes)

  if (!sets.length) {
    const existing = await getSocialAccount(id, projectSlug)
    if (!existing) return { error: 'not found', status: 404 }
    return { row: existing }
  }

  sets.push('updated_at = now()')
  params.push(id, projectId)

  const { rows } = await pool.query(
    `UPDATE social_accounts SET ${sets.join(', ')} WHERE id = $${i} AND project_id = $${i + 1} RETURNING *`,
    params,
  )
  if (!rows[0]) return { error: 'not found', status: 404 }
  return { row: rows[0] }
}

export async function deleteSocialAccount(id: string, projectSlug: string | null): Promise<boolean> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return false
  const { rowCount } = await pool.query('DELETE FROM social_accounts WHERE id = $1 AND project_id = $2', [id, projectId])
  return (rowCount ?? 0) > 0
}
