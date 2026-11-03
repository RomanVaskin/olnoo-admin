import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'

// Контент-завод — source registry. Pool-injected, no `@/` imports (same convention as
// lib/social-agent.ts) — directly testable under this project's plain `node --test`. Every query
// is scoped by project_id, exactly like the rest of this schema; a source id from another project
// never resolves here (see getSource/requireOwnSource below), the same project-isolation guarantee
// the Social module already gives its own rows.

export class ContentFactorySourceError extends Error {}

// Open-ended by design (the task asks the architecture to allow RSS/website/YouTube/etc. later)
// — only 'telegram' has an adapter implemented (lib/content-factory-telegram-source.ts). Any other
// value is accepted by the schema/CRUD below but `checkSourceNow` (lib/content-factory-check.ts)
// refuses it with a clear "not supported yet" error rather than silently doing nothing.
export const SOURCE_TYPES = ['telegram', 'rss', 'website', 'youtube'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]
export type SourceProcessingMode = 'ai' | 'copy'

export function isSourceType(value: unknown): value is SourceType {
  return typeof value === 'string' && (SOURCE_TYPES as readonly string[]).includes(value)
}

export type ContentFactorySource = {
  id: string
  projectId: number
  type: SourceType
  handle: string
  enabled: boolean
  processingMode: SourceProcessingMode
  copyPermissionConfirmed: boolean
  lastCheckedAt: string | null
  lastError: string
  createdAt: string
  updatedAt: string
}

function fromRow(row: Record<string, unknown>): ContentFactorySource {
  return {
    id: row.id as string,
    projectId: row.project_id as number,
    type: row.type as SourceType,
    handle: row.handle as string,
    enabled: row.enabled as boolean,
    processingMode: row.processing_mode === 'copy' ? 'copy' : 'ai',
    copyPermissionConfirmed: row.copy_permission_confirmed === true,
    lastCheckedAt: (row.last_checked_at as string) ?? null,
    lastError: (row.last_error as string) ?? '',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listSources(pool: Pool, projectId: number): Promise<ContentFactorySource[]> {
  const { rows } = await pool.query('SELECT * FROM content_factory_sources WHERE project_id = $1 ORDER BY created_at DESC', [projectId])
  return rows.map(fromRow)
}

export async function getSource(pool: Pool, projectId: number, id: string): Promise<ContentFactorySource | null> {
  const { rows } = await pool.query('SELECT * FROM content_factory_sources WHERE id = $1 AND project_id = $2', [id, projectId])
  return rows[0] ? fromRow(rows[0]) : null
}

export async function createSource(
  pool: Pool,
  projectId: number,
  input: { type: string; handle: string; processingMode?: string; copyPermissionConfirmed?: boolean },
): Promise<ContentFactorySource> {
  const type = isSourceType(input.type) ? input.type : null
  if (!type) throw new ContentFactorySourceError('Unknown source type.')
  const handle = input.handle.trim()
  if (!handle) throw new ContentFactorySourceError('A source handle/URL is required.')
  const processingMode = input.processingMode ?? 'ai'
  if (processingMode !== 'ai' && processingMode !== 'copy') throw new ContentFactorySourceError('Unknown source processing mode.')
  if (processingMode === 'copy' && (type !== 'telegram' || input.copyPermissionConfirmed !== true)) {
    throw new ContentFactorySourceError('Copy mode requires a Telegram source and confirmed permission to use its text.')
  }

  const id = randomUUID()
  const { rows } = await pool.query(
    `INSERT INTO content_factory_sources (id, project_id, type, handle, processing_mode, copy_permission_confirmed) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, projectId, type, handle, processingMode, processingMode === 'copy' && input.copyPermissionConfirmed === true],
  )
  return fromRow(rows[0])
}

export async function updateSource(
  pool: Pool,
  projectId: number,
  id: string,
  patch: { handle?: string; enabled?: boolean; processingMode?: string; copyPermissionConfirmed?: boolean },
): Promise<ContentFactorySource | null> {
  const existing = await getSource(pool, projectId, id)
  if (!existing) return null

  const handle = patch.handle !== undefined ? patch.handle.trim() : existing.handle
  if (!handle) throw new ContentFactorySourceError('A source handle/URL is required.')
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled
  const processingMode = patch.processingMode ?? existing.processingMode
  if (processingMode !== 'ai' && processingMode !== 'copy') throw new ContentFactorySourceError('Unknown source processing mode.')
  const copyPermissionConfirmed = patch.copyPermissionConfirmed ?? existing.copyPermissionConfirmed
  if (processingMode === 'copy' && (existing.type !== 'telegram' || !copyPermissionConfirmed)) {
    throw new ContentFactorySourceError('Copy mode requires a Telegram source and confirmed permission to use its text.')
  }

  const { rows } = await pool.query(
    `UPDATE content_factory_sources SET handle = $1, enabled = $2, processing_mode = $3, copy_permission_confirmed = $4, updated_at = now() WHERE id = $5 AND project_id = $6 RETURNING *`,
    [handle, enabled, processingMode, processingMode === 'copy' && copyPermissionConfirmed, id, projectId],
  )
  return rows[0] ? fromRow(rows[0]) : null
}

export async function deleteSource(pool: Pool, projectId: number, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM content_factory_sources WHERE id = $1 AND project_id = $2', [id, projectId])
  return (rowCount ?? 0) > 0
}

/** Records the outcome of a check — success clears any previous error, a failure is recorded
 * without throwing so a bad source never breaks a multi-source sweep (see
 * lib/content-factory-check.ts). */
export async function recordSourceCheckResult(pool: Pool, id: string, projectId: number, error: string): Promise<void> {
  await pool.query('UPDATE content_factory_sources SET last_checked_at = now(), last_error = $1, updated_at = now() WHERE id = $2 AND project_id = $3', [
    error,
    id,
    projectId,
  ])
}
