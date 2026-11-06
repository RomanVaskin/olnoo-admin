import { normalizeTelegramHandle } from './content-factory-telegram-source.ts'
import { DEFAULT_SOURCE_AUTOMATION, parseSourceAutomation, type SourceAutomation } from './content-factory-source-policy.ts'
import { publicSourceUrl } from './content-factory-web-fetch.ts'
import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'

// Контент-завод — source registry. Pool-injected, no `@/` imports (same convention as
// lib/social-agent.ts) — directly testable under this project's plain `node --test`. Every query
// is scoped by project_id, exactly like the rest of this schema; a source id from another project
// never resolves here (see getSource/requireOwnSource below), the same project-isolation guarantee
// the Social module already gives its own rows.

export class ContentFactorySourceError extends Error {}

function validateWebSourceUrl(value: string): void {
  try { publicSourceUrl(value) } catch { throw new ContentFactorySourceError('Use a public HTTP(S) source URL without credentials.') }
}

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
  monitorBaseline?: boolean
  automation?: SourceAutomation
  automationRevision?: string
  automationRuntime?: Record<string, any>
  duplicateCount?: number
  lastCheckedAt: string | null
  lastError: string
  createdAt: string
  updatedAt: string
}

export function sourceFromRow(row: Record<string, unknown>): ContentFactorySource {
  return {
    id: row.id as string,
    projectId: row.project_id as number,
    type: row.type as SourceType,
    handle: row.handle as string,
    enabled: row.enabled as boolean,
    processingMode: row.processing_mode === 'copy' ? 'copy' : 'ai',
    copyPermissionConfirmed: row.copy_permission_confirmed === true,
    automation: row.automation ? parseSourceAutomation(row.automation) : { ...DEFAULT_SOURCE_AUTOMATION },
    automationRevision: String(row.automation_revision ?? ''),
    automationRuntime: (row.automation_runtime ?? {}) as Record<string, any>,
    duplicateCount: Number(row.duplicate_count ?? 0),
    lastCheckedAt: (row.last_checked_at as string) ?? null,
    lastError: (row.last_error as string) ?? '',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listSources(pool: Pool, projectId: number): Promise<ContentFactorySource[]> {
  const { rows } = await pool.query("SELECT s.*, CASE WHEN type = 'telegram' THEN (SELECT count(*)::int FROM content_factory_sources d WHERE d.project_id = s.project_id AND d.type = 'telegram' AND d.id <> s.id AND content_factory_telegram_key(d.handle) = content_factory_telegram_key(s.handle)) ELSE 0 END AS duplicate_count FROM content_factory_sources s WHERE project_id = $1 AND handle NOT LIKE 'own-bot:%' ORDER BY created_at DESC", [projectId])
  return rows.map(sourceFromRow)
}

export async function getSource(pool: Pool, projectId: number, id: string): Promise<ContentFactorySource | null> {
  const { rows } = await pool.query('SELECT * FROM content_factory_sources WHERE id = $1 AND project_id = $2', [id, projectId])
  return rows[0] ? sourceFromRow(rows[0]) : null
}

export async function createSource(
  pool: Pool,
  projectId: number,
  input: { type: string; handle: string; processingMode?: string; copyPermissionConfirmed?: boolean; automation?: unknown },
  internalOwnIntake = false,
): Promise<ContentFactorySource> {
  const type = isSourceType(input.type) ? input.type : null
  if (!type) throw new ContentFactorySourceError('Unknown source type.')
  const internal = internalOwnIntake && type === 'telegram' && /^own-bot:[0-9]+$/.test(input.handle)
  if (internalOwnIntake && !internal) throw new ContentFactorySourceError('Invalid internal intake source.')
  const handle = internal ? input.handle : input.type === 'telegram' ? normalizeTelegramHandle(input.handle)?.toLowerCase() ?? '' : input.handle.trim()
  if (['rss', 'website'].includes(type)) validateWebSourceUrl(handle)
  if (!handle) throw new ContentFactorySourceError(type === 'telegram' ? 'Некорректный Telegram-адрес. Используйте channel, @channel или https://t.me/channel.' : 'A source handle/URL is required.')
  const processingMode = input.processingMode ?? 'ai'
  if (processingMode !== 'ai' && processingMode !== 'copy') throw new ContentFactorySourceError('Unknown source processing mode.')
  if (processingMode === 'copy' && (type !== 'telegram' || input.copyPermissionConfirmed !== true)) {
    throw new ContentFactorySourceError('Copy mode requires a Telegram source and confirmed permission to use its text.')
  }

  const automation = checkedAutomation(input.automation)
  if (internal && automation.mode !== 'manual') throw new ContentFactorySourceError('Own intake is manual only.')
  const insert = async (db: Pool) => {
    if (!internal) await validateSourceAutomation(db, projectId, type, handle, automation)
    const id = randomUUID()
    const { rows } = await db.query(
      `INSERT INTO content_factory_sources (id, project_id, type, handle, processing_mode, copy_permission_confirmed, automation, automation_revision) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`,
      [id, projectId, type, handle, processingMode, processingMode === 'copy' && input.copyPermissionConfirmed === true, JSON.stringify(automation), randomUUID()],
    )
    return sourceFromRow(rows[0])
  }
  // The allowlisted bot already owns its intake transaction; hidden sources are never swept.
  return internal ? insert(pool) : sourceWrite(pool, projectId, insert)
}

export async function updateSource(
  pool: Pool,
  projectId: number,
  id: string,
  patch: { handle?: string; enabled?: boolean; processingMode?: string; copyPermissionConfirmed?: boolean; automation?: unknown },
): Promise<ContentFactorySource | null> {
  return sourceWrite(pool, projectId, async (db) => {
    const existing = await getSource(db, projectId, id)
    if (!existing) return null

    if (existing.handle.startsWith('own-bot:')) throw new ContentFactorySourceError('Own material intake sources cannot be edited.')
    const rawHandle = patch.handle !== undefined ? patch.handle.trim() : existing.handle
    const handle = existing.type === 'telegram' ? normalizeTelegramHandle(rawHandle)?.toLowerCase() ?? '' : rawHandle
    if (['rss', 'website'].includes(existing.type)) validateWebSourceUrl(handle)
    if (!handle) throw new ContentFactorySourceError(existing.type === 'telegram' ? 'Некорректный Telegram-адрес. Используйте channel, @channel или https://t.me/channel.' : 'A source handle/URL is required.')
    const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled
    const processingMode = patch.processingMode ?? existing.processingMode
    if (processingMode !== 'ai' && processingMode !== 'copy') throw new ContentFactorySourceError('Unknown source processing mode.')
    const copyPermissionConfirmed = patch.copyPermissionConfirmed ?? existing.copyPermissionConfirmed
    if (processingMode === 'copy' && (existing.type !== 'telegram' || !copyPermissionConfirmed)) {
      throw new ContentFactorySourceError('Copy mode requires a Telegram source and confirmed permission to use its text.')
    }

    const automation = checkedAutomation(patch.automation ?? existing.automation)
    await validateSourceAutomation(db, projectId, existing.type, handle, automation, id, patch.enabled === false)
    const changed = patch.automation !== undefined || handle !== existing.handle || processingMode !== existing.processingMode || enabled !== existing.enabled || JSON.stringify(automation) !== JSON.stringify(existing.automation)
    const { rows } = await db.query(
      `UPDATE content_factory_sources SET handle = $1, enabled = $2, processing_mode = $3, copy_permission_confirmed = $4, automation = $7::jsonb, automation_revision = CASE WHEN $8 THEN $9 ELSE automation_revision END, automation_runtime = CASE WHEN $8 THEN (CASE WHEN $10 THEN automation_runtime - ARRAY['monitorCursor','monitorPeer'] ELSE automation_runtime END) - ARRAY['since','cursor','paused','failures','operation','error'] ELSE automation_runtime END, updated_at = now() WHERE id = $5 AND project_id = $6 RETURNING *`,
      [handle, enabled, processingMode, processingMode === 'copy' && copyPermissionConfirmed, id, projectId, JSON.stringify(automation), changed, randomUUID(), existing.type === 'telegram' && normalizeTelegramHandle(existing.handle)?.toLowerCase() !== handle],
    )
    return rows[0] ? sourceFromRow(rows[0]) : null
  })
}

export async function deleteSource(pool: Pool, projectId: number, id: string): Promise<boolean> {
  return sourceWrite(pool, projectId, async (db) => {
    const { rowCount } = await db.query('DELETE FROM content_factory_sources WHERE id = $1 AND project_id = $2', [id, projectId])
    return (rowCount ?? 0) > 0
  })
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

function checkedAutomation(value: unknown): SourceAutomation {
  try { return parseSourceAutomation(value) } catch (e) { throw new ContentFactorySourceError((e as Error).message) }
}
async function sourceWrite<T>(pool: Pool, projectId: number, write: (db: Pool) => Promise<T>): Promise<T> {
  // RSS finder already passes a transaction client; use its transaction rather than nesting it.
  const client = !('release' in pool) && typeof pool.connect === 'function' ? await pool.connect() : null
  const db = (client ?? pool) as unknown as Pool
  try {
    if (client) await client.query('BEGIN')
    await db.query('SELECT pg_advisory_xact_lock(78216, $1)', [projectId])
    const result = await write(db)
    if (client) await client.query('COMMIT')
    return result
  } catch (e) { if (client) await client.query('ROLLBACK'); throw e }
  finally { client?.release() }
}
async function validateSourceAutomation(db: Pool, projectId: number, type: SourceType, handle: string, automation: SourceAutomation, id = '', disabling = false) {
  if (type === 'telegram') {
    const duplicates = await db.query(`SELECT id, enabled FROM content_factory_sources WHERE project_id = $1 AND type = 'telegram'
      AND content_factory_telegram_key(handle) = $2 AND id <> $3`, [projectId, handle, id])
    if (duplicates.rows.length && !disabling && (!id || duplicates.rows.some((row) => row.enabled))) throw new ContentFactorySourceError('Этот Telegram-источник уже есть в проекте. Сохраните историю и отключите дубликаты; новый источник не создан.')
  }
  if (automation.mode !== 'manual' && type !== 'telegram') throw new ContentFactorySourceError('Автоматизация этого MVP доступна только Telegram; остальные источники собираются как раньше.')
  if (automation.accountId) {
    const account = await db.query("SELECT id FROM social_accounts WHERE id = $1 AND project_id = $2 AND platform = 'telegram' AND active = true AND status = 'connected'", [automation.accountId, projectId])
    if (!account.rows[0]) throw new ContentFactorySourceError('Подключите и выберите Telegram-канал этого проекта.')
  }
}
