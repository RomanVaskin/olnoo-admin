import { catalogPhotoVersionsValid, processedCatalogPhotos } from './catalog-photo-data.ts'
import { timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import { publishableCatalogCard, type CatalogCardInput, type CatalogCardKind } from './catalog-card.ts'

/** A read-only token binds its caller to exactly one project, independently of external Basic Auth. */
export function catalogSiteProject(token: string | null, raw = process.env.CATALOG_SITE_TOKENS): string | null {
  try {
    const map: unknown = JSON.parse(raw || '{}')
    if (!map || Array.isArray(map) || typeof map !== 'object') return null
    const entries = Object.entries(map)
    if (!entries.length || entries.some(([slug, value]) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) || typeof value !== 'string' || value.length < 32 || value.length > 256) || new Set(entries.map(([,v]) => v)).size !== entries.length) return null
    if (!token || token.length > 256) return null
    return entries.find(([, value]) => Buffer.byteLength(value as string) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value as string), Buffer.from(token)))?.[0] ?? null
  } catch { return null }
}
export function catalogInputFromRow(row: Record<string, unknown>): CatalogCardInput {
  return { slug: row.slug as string, title: row.title as string, description: row.description as string,
    lengthCm: row.length_cm == null ? null : Number(row.length_cm), diameterCm: row.diameter_cm == null ? null : Number(row.diameter_cm), offers: row.offers as CatalogCardInput['offers'], ...(row.photo_versions ? { photoVersions: row.photo_versions as CatalogCardInput['photoVersions'] } : {}) }
}
export function catalogPublicProjection(row: Record<string, unknown>) {
  const files = row.original_image_files
  const input = catalogInputFromRow(row)
  if (!row.published_at || row.origin_kind !== 'own' || row.original_image_error || !Array.isArray(files) || files.length !== String(row.original_image_urls || '').split(',').filter(Boolean).length || !publishableCatalogCard(input, files.length, (row.card_kind ?? 'legacy') as CatalogCardKind)) return null
  if (!catalogPhotoVersionsValid(row.photo_versions ?? {}, files, row.processed_image_versions)) return null
  // Explicit whitelist: never serialize the DB row, source text, file paths, or paid documents.
  const offers = Object.fromEntries(Object.entries(input.offers).map(([kind, offer]) => [kind, {
    title: offer.title, description: offer.description, priceRub: offer.priceRub, available: offer.available, imageIndexes: offer.imageIndexes,
  }]))
  return { id: row.id as string, slug: input.slug, title: input.title, description: input.description,
    lengthCm: input.lengthCm, diameterCm: input.diameterCm, offers, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at) }
}
export type RelatedCatalogCard = { id: string; slug: string; title: string; type: Exclude<CatalogCardKind, 'legacy'> }

/** Relations reuse only exportable cards; source/parent identifiers remain server-only. */
export function catalogPublicCards(rows: Record<string, unknown>[]): (NonNullable<ReturnType<typeof catalogPublicProjection>> & { relatedCards?: RelatedCatalogCard[] })[] {
  const entries = rows.flatMap((row) => {
    const card = catalogPublicProjection(row)
    return card ? [{ row, card }] : []
  })
  const sources = new Map<string, typeof entries>()
  function sourceKey(row: Record<string, unknown>) {
    return Number.isSafeInteger(row.project_id) && typeof row.item_id === 'string' && row.item_id
      ? `${row.project_id}:${row.item_id}` : null
  }
  for (const entry of entries) {
    const key = sourceKey(entry.row)
    if (key) {
      const group = sources.get(key) ?? []
      group.push(entry)
      sources.set(key, group)
    }
  }
  return entries.map(({ row, card }) => {
    const key = sourceKey(row)
    if (!key || !['raw', 'finished', 'guide'].includes(String(row.card_kind))) return card
    const relatedCards = (sources.get(key) ?? []).filter(({ row: other }) => {
      if (other.id === row.id) return false
      if (row.card_kind === 'raw') return other.card_kind === 'finished'
      if (other.card_kind === 'raw') return true
      if (row.card_kind === 'finished') return other.card_kind === 'guide' && other.parent_card_id === row.id
      return other.card_kind === 'finished' && row.parent_card_id === other.id
    }).map(({ row: other, card: related }) => ({
      id: related.id, slug: related.slug, title: related.title, type: other.card_kind as 'raw' | 'finished' | 'guide',
    }))
    return relatedCards.length ? { ...card, relatedCards } : card
  })
}

export async function publishedCatalogRows(pool: Pool, project: string, id?: string) {
  const { rows } = await pool.query(`SELECT c.id, c.card_kind, c.parent_card_id, c.photo_versions, c.slug, c.title, c.description, c.length_cm, c.diameter_cm, c.offers, c.published_at, c.updated_at,
    i.origin_kind, i.original_image_urls, i.original_image_files, i.original_image_error, i.processed_image_versions, i.project_id, i.id AS item_id
    FROM catalog_cards c JOIN projects p ON p.id = c.project_id
    JOIN content_factory_items i ON i.id = c.content_item_id AND i.project_id = c.project_id
    WHERE p.slug = $1 AND p.archived_at IS NULL AND c.published_at IS NOT NULL AND i.origin_kind = 'own'
      AND ($2::uuid IS NULL OR c.id = $2::uuid) ORDER BY c.created_at DESC`, [project, id ?? null])
  return rows as Record<string, unknown>[]
}

export function catalogPhotoSelection(row: Record<string, unknown>, index: number) {
  const card = catalogPublicProjection(row)
  if (!Number.isInteger(index) || index < 0 || index > 9 || !card || !Object.values(card.offers).some((offer) => offer.imageIndexes.includes(index))) return null
  const version = (row.photo_versions as Record<string, string> | undefined)?.[String(index)]
  if (version) {
    const processed = processedCatalogPhotos(row.processed_image_versions).find((v) => v.id === version && v.originalIndex === index && v.originalFilename === (row.original_image_files as string[])[index])
    return processed ? { projectId: Number(row.project_id), itemId: String(row.item_id), filename: processed.filename, processed: true } : null
  }
  return { projectId: Number(row.project_id), itemId: String(row.item_id), filename: (row.original_image_files as string[])[index] }
}
