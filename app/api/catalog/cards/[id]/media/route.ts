import { withCatalogSchemaGuard } from '@/lib/catalog-schema'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { catalogUuid, manualCatalogPhotos, type ManualCatalogPhoto } from '@/lib/catalog-manual-photo-data'
import { CATALOG_UPLOAD_MAX, CatalogMediaError, attachManualCatalogPhoto, importTelegramCatalogPhoto } from '@/lib/catalog-manual-media'
const headers = { 'Cache-Control': 'no-store' }
async function card(req: Request, id: string) {
  if (new URL(req.url).searchParams.get('project') !== 'istraart' || !catalogUuid(id)) return null
  const projectId = await resolveProjectId('istraart')
  if (!projectId) return null
  const { rows } = await pool.query(`SELECT c.manual_media FROM catalog_cards c JOIN content_factory_items i ON i.id=c.content_item_id AND i.project_id=c.project_id
    WHERE c.id=$1 AND c.project_id=$2 AND i.origin_kind='own'`, [id, projectId])
  return rows[0] ? { projectId, row: rows[0] } : null
}
async function get(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const found = await card(req, (await params).id)
  return found ? NextResponse.json({ media: manualCatalogPhotos(found.row.manual_media) }, { headers }) : NextResponse.json({ error: 'Not found' }, { status: 404, headers })
}
async function post(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = req.headers.get('origin')
  if (origin && origin !== new URL(req.url).origin && origin !== 'https://admin.olnoo.com') return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers })
  const { id } = await params
  const found = await card(req, id)
  if (!found) return NextResponse.json({ error: 'Not found' }, { status: 404, headers })
  try {
    // Bound JSON and multipart bodies before formData/base64 allocation. No new upload service.
    const reader = req.body?.getReader(), chunks: Buffer[] = []; let size = 0
    if (!reader) throw new CatalogMediaError('Выберите изображение.')
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > CATALOG_UPLOAD_MAX + 1024 * 1024) throw new CatalogMediaError('Размер загрузки превышает 11 МБ.'); chunks.push(Buffer.from(part.value)) } }
    finally { await reader.cancel().catch(() => {}) }
    const bytes = Buffer.concat(chunks), type = req.headers.get('content-type') || ''
    let media
    if (type.startsWith('application/json')) {
      const body = JSON.parse(bytes.toString('utf8'))
      if (!body || Object.keys(body).some((k) => !['itemId','index','kind','slot'].includes(k))) throw new CatalogMediaError('Некорректные данные фотографии.')
      media = await importTelegramCatalogPhoto(pool, found.projectId, id, body.itemId, body.index, body.kind, body.slot)
    } else if (type.startsWith('multipart/form-data')) {
      const form = await new Request(req.url, { method: 'POST', headers: { 'Content-Type': type }, body: bytes }).formData()
      if ([...form.keys()].some((k) => !['file','kind','slot'].includes(k))) throw new CatalogMediaError('Некорректная загрузка.')
      const file = form.get('file'), kind = form.get('kind') ?? 'unclassified', slot = form.get('slot')
      if (!(file instanceof File) || !['real','ai','unclassified'].includes(String(kind)) || !/^[0-9]$/.test(String(slot))) throw new CatalogMediaError('Выберите файл, его тип и позицию.')
      media = await attachManualCatalogPhoto(pool, found.projectId, id, Buffer.from(await file.arrayBuffer()), kind as ManualCatalogPhoto['kind'], Number(slot), 'upload')
    } else throw new CatalogMediaError('Используйте загрузку файла или Telegram-материал.')
    return NextResponse.json({ media }, { status: 201, headers })
  } catch (err) { return NextResponse.json({ error: err instanceof CatalogMediaError ? err.message : 'Не удалось добавить изображение. Исходники сохранены.' }, { status: err instanceof CatalogMediaError ? err.status : 422, headers }) }
}

export const GET = withCatalogSchemaGuard(get)
export const POST = withCatalogSchemaGuard(post)
