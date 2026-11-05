import { istraArtDeleteAccess, deleteIstraArtCard } from '@/lib/istraart-delete'
import { withCatalogSchemaGuard } from '@/lib/catalog-schema'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { catalogInputFromRow } from '@/lib/catalog-export'
import { readCatalogCardPhoto } from '@/lib/catalog-manual-media'
import { manualPhotoCount, manualPhotoSelectionValid } from '@/lib/catalog-manual-photo-data'
import { catalogCardErrors, publishableCatalogCard, validateCatalogCard, type CatalogCardKind } from '@/lib/catalog-card'

async function patch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'Unknown project' }, { status: 400 })
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  const { rows } = await pool.query<Record<string, any>>(
    `SELECT c.*, c.updated_at::text AS version, i.original_image_files, i.original_image_error, i.original_image_urls, i.origin_kind
       FROM catalog_cards c JOIN content_factory_items i
         ON i.id = c.content_item_id AND i.project_id = c.project_id
      WHERE c.id = $1 AND c.project_id = $2`, [id, projectId],
  )
  const current = rows[0]
  if (!current) return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  const kind = (current.card_kind ?? 'legacy') as CatalogCardKind
  const photoCount = manualPhotoCount(current.original_image_files, current.manual_media)
  if (current.origin_kind !== 'own') return NextResponse.json({ error: 'Owner material required' }, { status: 409 })
  if (body.action === 'publish' && Object.keys(body).length === 1) {
    const files = current.original_image_files
    if (!Array.isArray(files) || current.original_image_error || files.length !== String(current.original_image_urls || '').split(',').filter(Boolean).length || !publishableCatalogCard(catalogInputFromRow(current), photoCount, kind)) return NextResponse.json({ error: 'Проверьте поля и загрузку исходных фото перед публикацией.', fieldErrors: catalogCardErrors(catalogInputFromRow(current), photoCount, true, kind) }, { status: 422 })
    if (!manualPhotoSelectionValid(catalogInputFromRow(current), files, current.manual_media)) return NextResponse.json({ error: 'Выберите доступные фото этой карточки.' }, { status: 422 })
    const indexes = [...new Set(Object.values(catalogInputFromRow(current).offers).flatMap((offer) => offer.imageIndexes))]
    for (const index of indexes) if (!await readCatalogCardPhoto(projectId, id, current.content_item_id, files, current.manual_media, current.manual_photo_selection ?? {}, index).catch(() => null)) return NextResponse.json({ error: 'Выбранное исходное фото недоступно. Проверьте загрузку фотографий.', fieldErrors: Object.fromEntries(Object.entries(body.card?.offers ?? current.offers).filter(([, offer]) => (offer as { imageIndexes: number[] }).imageIndexes.includes(index)).map(([kind]) => [`offers.${kind}.imageIndexes`, 'Выбранное фото недоступно на сервере.'])) }, { status: 409 })
    const updated = await pool.query(
      'UPDATE catalog_cards SET published_at = COALESCE(published_at, now()), updated_at = now() WHERE id = $1 AND project_id = $2 AND updated_at = $3::timestamptz RETURNING id, slug, published_at',
      [id, projectId, current.version],
    )
    return updated.rows[0] ? NextResponse.json(updated.rows[0]) : NextResponse.json({ error: 'Card changed. Reload it.' }, { status: 409 })
  }
  if (body.action === 'unpublish' && Object.keys(body).length === 1) {
    const updated = await pool.query(
      'UPDATE catalog_cards SET published_at = NULL, updated_at = now() WHERE id = $1 AND project_id = $2 RETURNING id, slug, published_at',
      [id, projectId],
    )
    return NextResponse.json(updated.rows[0])
  }
  if (!body.card || Object.keys(body).some((key) => key !== 'card')) return NextResponse.json({ error: 'Invalid update' }, { status: 400 })
  if (!Array.isArray(current.original_image_files) || !validateCatalogCard(body.card, photoCount, kind)) {
    return NextResponse.json({ error: 'Проверьте отмеченные поля.', fieldErrors: catalogCardErrors(body.card, photoCount, false, kind) }, { status: 422 })
  }
  const card = body.card
  if (!manualPhotoSelectionValid(card, current.original_image_files, current.manual_media)) return NextResponse.json({ error: 'Проверьте выбор изображений.', fieldErrors: { manualPhotoSelection: 'Выберите файл этой карточки для каждой отмеченной позиции.' } }, { status: 422 })
  if (current.published_at && !publishableCatalogCard(card, photoCount, kind)) return NextResponse.json({ error: 'Опубликованные предложения должны оставаться заполненными. Для очистки снимите карточку с публикации.', fieldErrors: catalogCardErrors(card, photoCount, true, kind) }, { status: 422 })
  if (current.published_at) {
    const indexes = [...new Set(Object.values(card.offers as import('@/lib/catalog-card').CatalogOffers).flatMap((offer) => offer.imageIndexes))]
    for (const index of indexes) if (!await readCatalogCardPhoto(projectId, id, current.content_item_id, current.original_image_files, current.manual_media, card.manualPhotoSelection ?? {}, index).catch(() => null)) return NextResponse.json({ error: 'Выбранное исходное фото недоступно. Проверьте загрузку фотографий.', fieldErrors: Object.fromEntries(Object.entries(body.card?.offers ?? current.offers).filter(([, offer]) => (offer as { imageIndexes: number[] }).imageIndexes.includes(index)).map(([kind]) => [`offers.${kind}.imageIndexes`, 'Выбранное фото недоступно на сервере.'])) }, { status: 409 })
  }
  try {
    const updated = await pool.query(
      `UPDATE catalog_cards SET slug = $1, title = $2, description = $3, length_cm = $4,
         diameter_cm = $5, offers = $6::jsonb, manual_photo_selection = $10::jsonb, updated_at = now()
       WHERE id = $7 AND project_id = $8 AND updated_at = $9::timestamptz RETURNING id, slug, published_at`,
      [card.slug, card.title, card.description, card.lengthCm, card.diameterCm, JSON.stringify(card.offers), id, projectId, current.version, JSON.stringify(card.manualPhotoSelection ?? {})],
    )
    return updated.rows[0] ? NextResponse.json(updated.rows[0]) : NextResponse.json({ error: 'Card changed. Reload it.' }, { status: 409 })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return NextResponse.json({ error: 'Адрес уже используется.', fieldErrors: { slug: 'Выберите другой адрес карточки.' } }, { status: 409 })
    throw error
  }
}

export const PATCH = withCatalogSchemaGuard(patch)

/** Destructive owner-only operation, behind the existing Admin Basic Auth proxy. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = istraArtDeleteAccess(req)
  if (denied) return denied
  const projectId = await resolveProjectId('istraart')
  if (!projectId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const result = await deleteIstraArtCard(pool, projectId, id)
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
}
