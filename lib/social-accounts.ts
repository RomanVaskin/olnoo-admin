import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { isSocialChannel } from '@/lib/social'

const KNOWN_STATUSES = ['created', 'connected', 'error'] as const
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

/** Explicit column allowlist instead of a bare "select every column" query — these rows go
 * straight into `NextResponse.json(...)` in app/api/social-accounts*, so any column added to
 * `social_accounts` later (e.g. a future secret/token field) is never exposed to the browser just
 * by existing; it has to be added here deliberately first. Keep in sync with
 * db/migrations/0007_social_accounts_publications.sql and 0021_social_accounts_vk_credentials.sql.
 * `vk_access_token_encrypted` is deliberately NOT here — it is ciphertext, not plaintext, but there
 * is still no reason for it to ever leave the server; only lib/social-vk.ts and
 * lib/social-accounts-vk-connection.ts read it, via their own dedicated queries. `vk_group_id` and
 * `connection_error` are not secrets (a resolved numeric community id and a VK API error message)
 * and are safe to expose the same as every other column here. */
const ACCOUNT_COLUMNS =
  'id, project_id, platform, name, username, public_url, status, active, notes, vk_group_id, connection_error, created_at, updated_at'

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
    `SELECT ${ACCOUNT_COLUMNS} FROM social_accounts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
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
  const { rows } = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM social_accounts WHERE id = $1 AND project_id = $2`,
    [id, projectId],
  )
  return rows[0] ?? null
}

export async function createSocialAccount(
  projectSlug: string | null,
  input: SocialAccountFields,
): Promise<SocialAccountResult> {
  if (!isSocialChannel(input.platform)) return { error: 'a known platform is required', status: 400 }
  if (input.status && !isSocialAccountStatus(input.status)) return { error: 'invalid status', status: 400 }
  // Same reasoning as updateSocialAccount's guard below: a telegram account can't be created
  // already 'connected' outside the verified connect endpoint either.
  if (input.platform === 'telegram' && input.status === 'connected') {
    return {
      error:
        'Telegram channel connection status must be set through POST /api/social-accounts/[id]/telegram-connection, which verifies the bot can actually post there — not a direct create',
      status: 400,
    }
  }

  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const id = randomUUID()
  const { rows } = await pool.query(
    `
    INSERT INTO social_accounts (
      id, project_id, platform, name, username, public_url, status, active, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING ${ACCOUNT_COLUMNS}
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

  // Telegram's connection check (lib/social-accounts-telegram-connection.ts) only means anything
  // if a verified username/chat id and a 'connected' status can't also be set by any other path.
  // A plain PATCH changing `username` (the field the publisher trusts as the target chat) or
  // forcing `status` to 'connected' would silently invalidate that verification — the account
  // would look connected without the bot ever having been confirmed able to post there. So for a
  // telegram account, both are refused here unconditionally; they only ever change through
  // POST /api/social-accounts/[id]/telegram-connection, which actually calls the Telegram API
  // first. Every other field (name, public_url, notes, active, a non-'connected' status) is
  // unaffected — this is not a blanket lock on the account, just on the two fields that assert a
  // verified connection.
  if (typeof input.username === 'string' || input.status === 'connected') {
    const targetPlatform =
      input.platform ?? (await pool.query<{ platform: string }>('SELECT platform FROM social_accounts WHERE id = $1 AND project_id = $2', [id, projectId])).rows[0]?.platform
    if (targetPlatform === 'telegram') {
      return {
        error:
          'Telegram channel username/connection status must be set through POST /api/social-accounts/[id]/telegram-connection, which verifies the bot can actually post there — not a direct update',
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
    `UPDATE social_accounts SET ${sets.join(', ')} WHERE id = $${i} AND project_id = $${i + 1} RETURNING ${ACCOUNT_COLUMNS}`,
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
