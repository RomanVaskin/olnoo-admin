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

export function isSourceType(value: unknown): value is SourceType {
  return typeof value === 'string' && (SOURCE_TYPES as readonly string[]).includes(value)
}

export type ContentFactorySource = {
  id: string
  projectId: number
  type: SourceType
  handle: string
  enabled: boolean
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
  input: { type: string; handle: string },
): Promise<ContentFactorySource> {
  const type = isSourceType(input.type) ? input.type : null
  if (!type) throw new ContentFactorySourceError('Unknown source type.')
  const handle = input.handle.trim()
  if (!handle) throw new ContentFactorySourceError('A source handle/URL is required.')

  const id = randomUUID()
  const { rows } = await pool.query(
    `INSERT INTO content_factory_sources (id, project_id, type, handle) VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, projectId, type, handle],
  )
  return fromRow(rows[0])
}

export async function updateSource(
  pool: Pool,
  projectId: number,
  id: string,
  patch: { handle?: string; enabled?: boolean },
): Promise<ContentFactorySource | null> {
  const existing = await getSource(pool, projectId, id)
  if (!existing) return null

  const handle = patch.handle !== undefined ? patch.handle.trim() : existing.handle
  if (!handle) throw new ContentFactorySourceError('A source handle/URL is required.')
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled

  const { rows } = await pool.query(
    `UPDATE content_factory_sources SET handle = $1, enabled = $2, updated_at = now() WHERE id = $3 AND project_id = $4 RETURNING *`,
    [handle, enabled, id, projectId],
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
