import { manualPhotoSelectionValid } from '@/lib/catalog-manual-photo-data'
import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { catalogCardErrors, validateCatalogCard, type CatalogCardInput, type CatalogCardKind } from '@/lib/catalog-card'

/** Internal OLNOO Admin route; remains behind the existing external Admin access layer. */
export async function GET(req: Request) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'Unknown project' }, { status: 400 })
  const { rows } = await pool.query(
    'SELECT id, content_item_id, card_kind, parent_card_id, manual_media, manual_photo_selection, slug, title, description, length_cm, diameter_cm, offers, published_at FROM catalog_cards WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId],
  )
  return NextResponse.json(rows)
}

export async function POST(req: Request) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'Unknown project' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body.contentItemId !== 'string' || !body.card) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  const kind = body.cardKind ?? 'legacy'
  if (!['legacy', 'raw', 'finished', 'guide'].includes(kind)
    || Object.keys(body).some((key) => !['contentItemId', 'card', 'cardKind', 'parentCardId', 'createRaw', 'createGuide'].includes(key))
    || ['createRaw', 'createGuide'].some((key) => body[key] !== undefined && typeof body[key] !== 'boolean')
    || (kind !== 'finished' && (body.createRaw || body.createGuide))
    || (kind === 'guide' ? typeof body.parentCardId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.parentCardId) : body.parentCardId != null)) {
    return NextResponse.json({ error: 'Проверьте тип карточки и связь гайда с изделием.' }, { status: 400 })
  }
  const { rows } = await pool.query<{ id: string; original_image_files: unknown }>(
    "SELECT id, original_image_files FROM content_factory_items WHERE id = $1 AND project_id = $2 AND origin_kind = 'own'",
    [body.contentItemId, projectId],
  )
  if (!rows[0]) return NextResponse.json({ error: 'Owner material not found' }, { status: 404 })
  const files = rows[0].original_image_files
  if (!Array.isArray(files) || !validateCatalogCard(body.card, files.length, kind)) return NextResponse.json({ error: 'Проверьте отмеченные поля.', fieldErrors: catalogCardErrors(body.card, Array.isArray(files) ? files.length : -1, false, kind) }, { status: 422 })
  const card: CatalogCardInput = body.card
  if (!manualPhotoSelectionValid(card, files, [])) return NextResponse.json({ error: 'Изображение не принадлежит новой карточке.' }, { status: 422 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (kind === 'guide') {
      const parent = await client.query("SELECT id FROM catalog_cards WHERE id = $1 AND project_id = $2 AND content_item_id = $3 AND card_kind = 'finished' FOR KEY SHARE", [body.parentCardId, projectId, body.contentItemId])
      if (!parent.rows[0]) {
        await client.query('ROLLBACK')
        return NextResponse.json({ error: 'Изделие не найдено в этом проекте и исходном материале.' }, { status: 404 })
      }
    }
    async function insert(input: CatalogCardInput, cardKind: CatalogCardKind, parentId: string | null = null) {
      const id = randomUUID()
      const result = await client.query(
        `INSERT INTO catalog_cards
          (id, project_id, content_item_id, slug, title, description, length_cm, diameter_cm, offers, card_kind, parent_card_id, manual_photo_selection)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb)
         RETURNING id, slug, published_at, card_kind, parent_card_id`,
        [id, projectId, body.contentItemId, input.slug, input.title, input.description, input.lengthCm, input.diameterCm, JSON.stringify(input.offers), cardKind, parentId, JSON.stringify(input.manualPhotoSelection ?? {})],
      )
      return result.rows[0]
    }
    const created = await insert(card, kind, body.parentCardId ?? null)
    const createdCards = [created]
    for (const related of ['raw', 'guide'] as const) {
      if (!(related === 'raw' ? body.createRaw : body.createGuide)) continue
      const suffix = randomUUID().replaceAll('-', '')
      const label = related === 'raw' ? 'Исходный материал' : 'DIY-гайд'
      createdCards.push(await insert({ slug: `${card.slug.slice(0, 60).replace(/-$/, '')}-${related}-${suffix}`, title: `${label}: ${card.title}`.slice(0, 160), description: '', lengthCm: null, diameterCm: null, offers: {} }, related, related === 'guide' ? created.id : null))
    }
    await client.query('COMMIT')
    return NextResponse.json({ ...created, createdCards }, { status: 201 })
  } catch (error) {
    await client.query('ROLLBACK')
    const code = (error as { code?: string }).code
    if (code === '23505') return NextResponse.json({ error: 'Адрес или прежняя карточка материала уже существуют.', fieldErrors: { slug: 'Выберите другой адрес карточки или откройте существующую.' } }, { status: 409 })
    if (code === '23503' || code === 'P0001') return NextResponse.json({ error: 'Связь с исходным материалом или изделием изменилась. Перезагрузите редактор.' }, { status: 409 })
    throw error
  } finally { client.release() }
}
