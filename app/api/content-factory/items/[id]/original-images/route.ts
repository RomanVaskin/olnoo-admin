import type { PoolClient } from 'pg'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem } from '@/lib/content-factory-items'
import { unlink } from 'node:fs/promises'
import { CATALOG_UPLOAD_MAX, CatalogMediaError, inspectCatalogUpload } from '@/lib/catalog-manual-media'
import { catalogUuid } from '@/lib/catalog-manual-photo-data'
import { syncOriginalImages, writeOriginalImage, originalImagePath } from '@/lib/content-factory-original-images'
import { getSource } from '@/lib/content-factory-sources'
import { fetchPublicTelegramChannel, normalizeTelegramHandle } from '@/lib/content-factory-telegram-source'

// Append immutable owner files using the existing original-media storage. Never rewrite Telegram input.
async function uploadOwnImage(req: Request, projectId: number, id: string) {
  const headers = { 'Cache-Control': 'no-store' }
  const origin = req.headers.get('origin')
  if (origin && origin !== new URL(req.url).origin && origin !== 'https://admin.olnoo.com') return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers })
  if (new URL(req.url).searchParams.get('project') !== 'istraart' || !catalogUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404, headers })
  let client: PoolClient | undefined, filename = '', commitSent = false
  try {
    const reader = req.body?.getReader(), chunks: Buffer[] = []; let size = 0
    if (!reader) throw new CatalogMediaError('Выберите файл.')
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > CATALOG_UPLOAD_MAX + 1024 * 1024) throw new CatalogMediaError('Размер загрузки превышает 11 МБ.'); chunks.push(Buffer.from(part.value)) } }
    finally { await reader.cancel().catch(() => {}) }
    const form = await new Request(req.url, { method: 'POST', headers: { 'Content-Type': req.headers.get('content-type')! }, body: Buffer.concat(chunks) }).formData()
    if (form.getAll('file').length !== 1 || [...form.keys()].some((k) => k !== 'file') || !(form.get('file') instanceof File)) throw new CatalogMediaError('Выберите один файл изображения.')
    const bytes = Buffer.from(await (form.get('file') as File).arrayBuffer())
    await inspectCatalogUpload(bytes)
    client = await pool.connect(); await client.query('BEGIN')
    const cards = await client.query('SELECT id, published_at FROM catalog_cards WHERE content_item_id=$1 AND project_id=$2 ORDER BY id FOR UPDATE', [id, projectId])
    if (cards.rows.some((c) => c.published_at)) throw new CatalogMediaError('Исходник опубликованного товара нельзя менять.', 409)
    const current = await client.query(`SELECT i.* FROM content_factory_items i JOIN projects p ON p.id=i.project_id
      WHERE i.id=$1 AND i.project_id=$2 AND i.origin_kind='own' AND p.slug='istraart' AND p.archived_at IS NULL FOR UPDATE OF i`, [id, projectId])
    const item = current.rows[0]
    if (!item) throw new CatalogMediaError('Собственный материал не найден.', 404)
    if (!['new','failed'].includes(item.status) || item.generated_text || item.social_post_id || item.en_social_post_id || item.en_publish_claimed) throw new CatalogMediaError('Добавление исходных фото доступно до подготовки и публикации.', 409)
    const files = item.original_image_files
    if (!Array.isArray(files) || files.length >= 10 || item.original_image_error || files.length !== String(item.original_image_urls || '').split(',').filter(Boolean).length) throw new CatalogMediaError('Проверьте загрузку исходников: допускается не более 10 полностью сохранённых фотографий.', 409)
    filename = await writeOriginalImage(projectId, id, bytes)
    await client.query(`UPDATE content_factory_items SET original_image_files=original_image_files || to_jsonb($1::text),
      original_image_urls=CASE WHEN original_image_urls='' THEN $2 ELSE original_image_urls || ',' || $2 END, updated_at=now()
      WHERE id=$3 AND project_id=$4`, [filename, `upload:${filename}`, id, projectId])
    commitSent = true; await client.query('COMMIT')
    client.release(); client = undefined
    return NextResponse.json(await getItem(pool, projectId, id), { status: 201, headers })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    if (filename && !commitSent) await unlink(originalImagePath(projectId, id, filename)).catch(() => {})
    return NextResponse.json({ error: commitSent ? 'Результат загрузки не подтверждён. Обновите материал и проверьте фотографии перед повтором.' : error instanceof CatalogMediaError ? error.message : 'Не удалось добавить исходное фото. Предыдущие файлы сохранены.' }, { status: commitSent ? 503 : error instanceof CatalogMediaError ? error.status : 500, headers })
  } finally { client?.release() }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const projectId = await resolveProjectId(new URL(req.url).searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  const { id } = await params
  if (req.headers.get('content-type')?.startsWith('multipart/form-data')) return uploadOwnImage(req, projectId, id)
  const item = await getItem(pool, projectId, id)
  if (!item || item.processingMode !== 'copy') return NextResponse.json({ error: 'Partner copy not found.' }, { status: 404 })
  if (item.socialPostId || item.enSocialPostId || item.enPublishClaimed || item.status === 'published' || item.status === 'scheduled') return NextResponse.json({ error: 'Published material cannot be changed.' }, { status: 409 })
  const source = await getSource(pool, projectId, item.sourceId)
  const handle = source?.type === 'telegram' ? normalizeTelegramHandle(source.handle) : null
  let freshUrls: string[] | undefined
  if (handle && normalizeTelegramHandle(item.originalUrl) === handle) {
    try {
      freshUrls = (await fetchPublicTelegramChannel(handle)).find((message) => message.externalId === item.externalId)?.imageUrls
    } catch {
      // The stored URLs can still work when the public preview is temporarily unavailable.
    }
  }
  await syncOriginalImages(pool, item, fetch, freshUrls)
  const updated = await getItem(pool, projectId, id)
  if (!updated) return NextResponse.json({ error: 'Material disappeared during image download.' }, { status: 404 })
  return NextResponse.json(updated)
}
