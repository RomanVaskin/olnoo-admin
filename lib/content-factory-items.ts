import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import type { RawSourceMessage } from './content-factory-telegram-source.ts'

// Контент-завод — the discovered-publications queue ("Материалы"). Pool-injected, no `@/`
// imports, project-scoped like lib/content-factory-sources.ts.

export class ContentFactoryItemError extends Error {}

export const ITEM_STATUSES = ['new', 'processing', 'ready', 'scheduled', 'published', 'needs_review', 'rejected', 'failed'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]

export function isItemStatus(value: unknown): value is ItemStatus {
  return typeof value === 'string' && (ITEM_STATUSES as readonly string[]).includes(value)
}

export type ContentFactoryItem = {
  id: string
  projectId: number
  sourceId: string
  externalId: string
  originalUrl: string
  originalText: string
  originalImageUrls: string[]
  originalPublishedAt: string | null
  status: ItemStatus
  generatedTitle: string
  generatedText: string
  reviewReason: string
  error: string
  socialPostId: string | null
  createdAt: string
  updatedAt: string
}

function fromRow(row: Record<string, unknown>): ContentFactoryItem {
  return {
    id: row.id as string,
    projectId: row.project_id as number,
    sourceId: row.source_id as string,
    externalId: row.external_id as string,
    originalUrl: (row.original_url as string) ?? '',
    originalText: (row.original_text as string) ?? '',
    originalImageUrls: ((row.original_image_urls as string) ?? '').split(',').filter(Boolean),
    originalPublishedAt: (row.original_published_at as string) ?? null,
    status: (row.status as ItemStatus) ?? 'new',
    generatedTitle: (row.generated_title as string) ?? '',
    generatedText: (row.generated_text as string) ?? '',
    reviewReason: (row.review_reason as string) ?? '',
    error: (row.error as string) ?? '',
    socialPostId: (row.social_post_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

/**
 * Inserts one new item per message not already stored for this source — the DB's own
 * `UNIQUE (source_id, external_id)` is what actually guarantees no duplicate ("Исключить
 * повторную обработку одного сообщения"); `ON CONFLICT DO NOTHING` makes a repeat check of the
 * same source idempotent rather than erroring. Returns only the messages that were genuinely new.
 */
export async function storeNewSourceMessages(
  pool: Pool,
  projectId: number,
  sourceId: string,
  messages: RawSourceMessage[],
): Promise<ContentFactoryItem[]> {
  const created: ContentFactoryItem[] = []
  for (const msg of messages) {
    const id = randomUUID()
    const { rows } = await pool.query(
      `INSERT INTO content_factory_items (
         id, project_id, source_id, external_id, original_url, original_text,
         original_image_urls, original_published_at, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new')
       ON CONFLICT (source_id, external_id) DO NOTHING
       RETURNING *`,
      [id, projectId, sourceId, msg.externalId, msg.url, msg.text, msg.imageUrls.join(','), msg.publishedAt || null],
    )
    if (rows[0]) created.push(fromRow(rows[0]))
  }
  return created
}

export async function listItems(
  pool: Pool,
  projectId: number,
  filters: { status?: string; sourceId?: string } = {},
): Promise<ContentFactoryItem[]> {
  const clauses = ['project_id = $1']
  const params: unknown[] = [projectId]
  if (filters.status && isItemStatus(filters.status)) {
    params.push(filters.status)
    clauses.push(`status = $${params.length}`)
  }
  if (filters.sourceId) {
    params.push(filters.sourceId)
    clauses.push(`source_id = $${params.length}`)
  }
  const { rows } = await pool.query(`SELECT * FROM content_factory_items WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
  return rows.map(fromRow)
}

export async function getItem(pool: Pool, projectId: number, id: string): Promise<ContentFactoryItem | null> {
  const { rows } = await pool.query('SELECT * FROM content_factory_items WHERE id = $1 AND project_id = $2', [id, projectId])
  return rows[0] ? fromRow(rows[0]) : null
}

export async function countItemsByStatus(pool: Pool, projectId: number): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: string; count: string }>(
    'SELECT status, COUNT(*)::text AS count FROM content_factory_items WHERE project_id = $1 GROUP BY status',
    [projectId],
  )
  const out: Record<string, number> = {}
  for (const row of rows) out[row.status] = Number(row.count)
  return out
}

// --- Status transitions — pure, so they're the same source of truth for the API routes and for
// the UI's own button-disabling logic (no @/ import, intentionally duplicated as a plain literal
// in the client component for the same client-bundle-hygiene reason EDITOR_ACTIONS already is in
// social-view.tsx — see components/sections/content-factory-items-view.tsx). ---

/** Generation may (re-)run from any state except while already running or already
 * scheduled/published — a published or in-flight item is never silently overwritten. */
export function canGenerate(status: ItemStatus): boolean {
  return status === 'new' || status === 'ready' || status === 'needs_review' || status === 'rejected' || status === 'failed'
}

/** Only a flagged item needs an explicit approval step before it may be published. */
export function canApprove(status: ItemStatus): boolean {
  return status === 'needs_review'
}

/** Publishing requires a generated, approved text — never straight from 'needs_review', and never
 * a second time once it's already scheduled/published. */
export function canPublish(status: ItemStatus): boolean {
  return status === 'ready'
}

export function canReject(status: ItemStatus): boolean {
  return status === 'new' || status === 'ready' || status === 'needs_review' || status === 'failed'
}

export async function setItemStatus(
  pool: Pool,
  projectId: number,
  id: string,
  patch: { status: ItemStatus; error?: string; reviewReason?: string },
): Promise<ContentFactoryItem | null> {
  const { rows } = await pool.query(
    `UPDATE content_factory_items
     SET status = $1, error = $2, review_reason = $3, updated_at = now()
     WHERE id = $4 AND project_id = $5
     RETURNING *`,
    [patch.status, patch.error ?? '', patch.reviewReason ?? '', id, projectId],
  )
  return rows[0] ? fromRow(rows[0]) : null
}

export async function setGeneratedContent(
  pool: Pool,
  projectId: number,
  id: string,
  content: { title: string; text: string; status: ItemStatus; reviewReason: string },
): Promise<ContentFactoryItem | null> {
  const { rows } = await pool.query(
    `UPDATE content_factory_items
     SET generated_title = $1, generated_text = $2, status = $3, review_reason = $4, error = '', updated_at = now()
     WHERE id = $5 AND project_id = $6
     RETURNING *`,
    [content.title, content.text, content.status, content.reviewReason, id, projectId],
  )
  return rows[0] ? fromRow(rows[0]) : null
}

/** Manual edit of the prepared text — never touches status (an edit alone doesn't re-approve a
 * needs_review item; see canApprove). */
export async function editGeneratedContent(pool: Pool, projectId: number, id: string, content: { title: string; text: string }): Promise<ContentFactoryItem | null> {
  const { rows } = await pool.query(
    `UPDATE content_factory_items SET generated_title = $1, generated_text = $2, updated_at = now() WHERE id = $3 AND project_id = $4 RETURNING *`,
    [content.title, content.text, id, projectId],
  )
  return rows[0] ? fromRow(rows[0]) : null
}

export async function setItemSocialPostId(pool: Pool, projectId: number, id: string, socialPostId: string): Promise<void> {
  await pool.query('UPDATE content_factory_items SET social_post_id = $1, updated_at = now() WHERE id = $2 AND project_id = $3', [
    socialPostId,
    id,
    projectId,
  ])
}
