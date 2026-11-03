import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import type { RawSourceMessage } from './content-factory-telegram-source.ts'
import type { SourceProcessingMode } from './content-factory-sources.ts'

// Контент-завод — the discovered-publications queue ("Материалы"). Pool-injected, no `@/`
// imports, project-scoped like lib/content-factory-sources.ts.

export class ContentFactoryItemError extends Error {}

export type PostLanguage = 'ru' | 'en'
export function detectPostLanguage(text: string): PostLanguage | null {
  const prose = text.replace(/https?:\/\/\S+|@[a-z0-9_]+/gi, '')
  const cyrillic = (prose.match(/[а-яё]/gi) ?? []).length
  const latin = (prose.match(/[a-z]/gi) ?? []).length
  if (cyrillic >= 5 && cyrillic > latin * 1.5) return 'ru'
  if (latin >= 5 && latin > cyrillic * 1.5) return 'en'
  return null
}

export const ITEM_STATUSES = ['new', 'processing', 'ready', 'scheduled', 'published', 'needs_review', 'rejected', 'failed'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]

export type ContentFactoryAiReview = {
  status: 'checking' | 'passed' | 'changes_required' | 'blocked' | 'error'
  risk?: 'low' | 'medium' | 'high'
  passed?: boolean
  issues?: { category: string; detail: string; example: string }[]
  recommendations?: string[]
  quality?: { passed: boolean; issues: { category: string; detail: string; example: string }[]; recommendations: string[] }
  checkedAt?: string
  error?: string
  claimId?: string
  reviewedTitle?: string
  reviewedText?: string
  reviewedImageFilename?: string
}

export function hasPassedAiReview(item: ContentFactoryItem): boolean {
  const review = item.aiReview
  return review?.status === 'passed' && (review.risk === 'low' || review.risk === 'medium') && review.passed === true && review.quality?.passed === true
    && review.reviewedTitle === item.generatedTitle
    && review.reviewedText === item.generatedText
    && review.reviewedImageFilename === item.imageFilename
}

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
  originalImageFiles: string[]
  originalImageError: string
  copyImagePermissionConfirmed: boolean
  processingMode: SourceProcessingMode
  copyPermissionConfirmed: boolean
  copyApprovedAt: string | null
  originalPublishedAt: string | null
  status: ItemStatus
  generatedTitle: string
  generatedText: string
  sourceLanguage: PostLanguage | null
  ruText: string
  ruSourceText: string
  ruRightsConfirmed: boolean
  reviewReason: string
  aiReview: ContentFactoryAiReview | null
  error: string
  socialPostId: string | null
  ruAccountId: string | null
  ruApprovedAt: string | null
  enText: string
  enSourceText: string
  enApprovedAt: string | null
  enRightsConfirmed: boolean
  enAccountId: string | null
  enSocialPostId: string | null
  enPublishClaimed: boolean
  imageFilename: string
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
    originalImageFiles: Array.isArray(row.original_image_files) ? row.original_image_files as string[] : [],
    originalImageError: (row.original_image_error as string) ?? '',
    copyImagePermissionConfirmed: row.copy_image_permission_confirmed === true,
    processingMode: row.processing_mode === 'copy' ? 'copy' : 'ai',
    copyPermissionConfirmed: row.copy_permission_confirmed === true,
    copyApprovedAt: (row.copy_approved_at as string) ?? null,
    originalPublishedAt: (row.original_published_at as string) ?? null,
    status: (row.status as ItemStatus) ?? 'new',
    generatedTitle: (row.generated_title as string) ?? '',
    generatedText: (row.generated_text as string) ?? '',
    sourceLanguage: row.source_language === 'ru' || row.source_language === 'en' ? row.source_language : null,
    ruText: (row.ru_text as string) ?? '',
    ruSourceText: (row.ru_source_text as string) ?? '',
    ruRightsConfirmed: row.ru_rights_confirmed === true,
    reviewReason: (row.review_reason as string) ?? '',
    aiReview: (row.ai_review as ContentFactoryAiReview | null) ?? null,
    error: (row.error as string) ?? '',
    socialPostId: (row.social_post_id as string) ?? null,
    ruAccountId: (row.ru_account_id as string) ?? null,
    ruApprovedAt: (row.ru_approved_at as string) ?? null,
    enText: (row.en_text as string) ?? '',
    enSourceText: (row.en_source_text as string) ?? '',
    enApprovedAt: (row.en_approved_at as string) ?? null,
    enRightsConfirmed: row.en_rights_confirmed === true,
    enAccountId: (row.en_account_id as string) ?? null,
    enSocialPostId: (row.en_social_post_id as string) ?? null,
    enPublishClaimed: row.en_publish_claimed === true,
    imageFilename: (row.image_filename as string) ?? '',
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
  sourcePolicy: { processingMode: SourceProcessingMode; copyPermissionConfirmed: boolean } = { processingMode: 'ai', copyPermissionConfirmed: false },
): Promise<ContentFactoryItem[]> {
  const created: ContentFactoryItem[] = []
  for (const msg of messages) {
    const id = randomUUID()
    const { rows } = await pool.query(
      `INSERT INTO content_factory_items (
         id, project_id, source_id, external_id, original_url, original_text,
         original_image_urls, original_published_at, status, generated_text, review_reason,
         processing_mode, copy_permission_confirmed, source_language
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (source_id, external_id) DO NOTHING
       RETURNING *`,
      [id, projectId, sourceId, msg.externalId, msg.url, msg.text, msg.imageUrls.join(','), msg.publishedAt || null,
        sourcePolicy.processingMode === 'copy' ? (msg.text ? 'needs_review' : 'failed') : 'new',
        sourcePolicy.processingMode === 'copy' ? msg.text : '',
        sourcePolicy.processingMode === 'copy' ? 'Compare the public preview text with the original Telegram post before approving; preview completeness is not verified.' : '',
        sourcePolicy.processingMode, sourcePolicy.processingMode === 'copy' && sourcePolicy.copyPermissionConfirmed,
        sourcePolicy.processingMode === 'copy' ? detectPostLanguage(msg.text) : null],
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

export function hasApprovedPartnerCopy(item: ContentFactoryItem): boolean {
  return item.processingMode === 'copy' && item.copyPermissionConfirmed && !!item.copyApprovedAt
    && !!item.originalText && item.generatedText === item.originalText && !item.imageFilename
    && !item.originalImageError && item.originalImageFiles.length === item.originalImageUrls.length
    && (item.originalImageUrls.length === 0 || item.copyImagePermissionConfirmed)
}

/** Explicit human comparison with the original is required because the public HTML preview
 * cannot prove it is complete. An atomic status/unchanged-text condition prevents stale approvals. */
export async function approvePartnerCopy(pool: Pool, projectId: number, id: string, confirmImageRights: boolean): Promise<ContentFactoryItem | null> {
  const { rows } = await pool.query(
    `UPDATE content_factory_items SET status = 'ready', copy_approved_at = now(),
       copy_image_permission_confirmed = CASE WHEN original_image_urls = '' THEN false ELSE $3 END, updated_at = now()
     WHERE id = $1 AND project_id = $2 AND processing_mode = 'copy'
       AND copy_permission_confirmed = true AND status = 'needs_review'
       AND original_text <> '' AND generated_text = original_text AND image_filename = ''
       AND original_image_error = ''
       AND jsonb_array_length(original_image_files) = CASE WHEN original_image_urls = '' THEN 0 ELSE cardinality(string_to_array(original_image_urls, ',')) END
       AND (original_image_urls = '' OR $3 = true)
     RETURNING *`, [id, projectId, confirmImageRights],
  )
  return rows[0] ? fromRow(rows[0]) : null
}

/** Serializes the first Social-post creation for a manually approved copy. */
export async function claimPartnerCopyPublish(pool: Pool, projectId: number, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE content_factory_items SET status = 'scheduled', updated_at = now()
     WHERE id = $1 AND project_id = $2 AND processing_mode = 'copy'
       AND status IN ('ready', 'failed') AND social_post_id IS NULL
       AND copy_permission_confirmed = true AND copy_approved_at IS NOT NULL
       AND original_text <> '' AND generated_text = original_text AND image_filename = ''
       AND original_image_error = ''
       AND jsonb_array_length(original_image_files) = CASE WHEN original_image_urls = '' THEN 0 ELSE cardinality(string_to_array(original_image_urls, ',')) END
       AND (original_image_urls = '' OR copy_image_permission_confirmed = true)`,
    [id, projectId],
  )
  return (rowCount ?? 0) === 1
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
     SET generated_title = $1, generated_text = $2, status = $3, review_reason = $4, source_language = $7, ai_review = NULL, error = '', updated_at = now()
     WHERE id = $5 AND project_id = $6 AND social_post_id IS NULL AND en_social_post_id IS NULL AND en_publish_claimed = false
     RETURNING *`,
    [content.title, content.text, content.status, content.reviewReason, id, projectId, detectPostLanguage(content.text)],
  )
  return rows[0] ? fromRow(rows[0]) : null
}

/** One atomic claim prevents two simultaneous clicks from making two paid review calls. */
export async function claimAiReview(pool: Pool, projectId: number, id: string): Promise<ContentFactoryItem | null> {
  const claimId = randomUUID()
  const { rows } = await pool.query(
    `UPDATE content_factory_items SET ai_review = $1::jsonb, updated_at = now()
     WHERE id = $2 AND project_id = $3 AND social_post_id IS NULL AND en_social_post_id IS NULL AND en_publish_claimed = false
       AND status IN ('ready', 'needs_review', 'failed')
       AND (ai_review IS NULL OR COALESCE(ai_review->>'status', '') NOT IN ('checking', 'passed')
            OR (ai_review->>'status' = 'checking' AND updated_at < now() - interval '15 minutes'))
     RETURNING *`,
    [JSON.stringify({ status: 'checking', claimId }), id, projectId],
  )
  return rows[0] ? fromRow(rows[0]) : null
}

/** A concurrent edit clears the claim; its stale AI answer cannot attach to the new text. */
export async function finishAiReview(
  pool: Pool, projectId: number, id: string,
  snapshot: { title: string; text: string; imageFilename: string; claimId: string },
  review: ContentFactoryAiReview,
): Promise<ContentFactoryItem | null> {
  const { rows } = await pool.query(
    `UPDATE content_factory_items SET ai_review = $1::jsonb, updated_at = now()
     WHERE id = $2 AND project_id = $3 AND social_post_id IS NULL AND en_social_post_id IS NULL AND en_publish_claimed = false
       AND ai_review->>'status' = 'checking'
       AND ai_review->>'claimId' = $4
       AND generated_title = $5 AND generated_text = $6 AND image_filename = $7
     RETURNING *`,
    [JSON.stringify(review), id, projectId, snapshot.claimId, snapshot.title, snapshot.text, snapshot.imageFilename],
  )
  return rows[0] ? fromRow(rows[0]) : null
}

/** Manual edit of the prepared text — never touches status (an edit alone doesn't re-approve a
 * needs_review item; see canApprove). */
export async function editGeneratedContent(pool: Pool, projectId: number, id: string, content: { title: string; text: string }): Promise<ContentFactoryItem | null> {
  const { rows } = await pool.query(
    `UPDATE content_factory_items SET generated_title = $1, generated_text = $2, source_language = $5, ai_review = NULL, updated_at = now() WHERE id = $3 AND project_id = $4 AND social_post_id IS NULL AND en_social_post_id IS NULL AND en_publish_claimed = false AND status NOT IN ('scheduled', 'processing', 'published') RETURNING *`,
    [content.title, content.text, id, projectId, detectPostLanguage(content.text)],
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

export async function setItemImageFilename(pool: Pool, projectId: number, id: string, filename: string): Promise<ContentFactoryItem | null> {
  const { rows } = await pool.query(
    "UPDATE content_factory_items SET image_filename = $1, updated_at = now() WHERE id = $2 AND project_id = $3 AND status IN ('ready', 'needs_review') AND social_post_id IS NULL AND en_social_post_id IS NULL AND en_publish_claimed = false RETURNING *",
    [filename, id, projectId],
  )
  return rows[0] ? fromRow(rows[0]) : null
}
