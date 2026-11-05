import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { Pool } from 'pg'
import { readOriginalImage } from './content-factory-original-images.ts'
import { catalogUuid, manualCatalogPhotos, type ManualCatalogPhoto } from './catalog-manual-photo-data.ts'
export const CATALOG_UPLOAD_MAX = 10 * 1024 * 1024
export class CatalogMediaError extends Error { status: number; constructor(message: string, status = 422) { super(message); this.status = status } }
export function catalogManualImagePath(projectId: number, cardId: string, filename: string): string {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !catalogUuid(cardId) || !/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(filename)) throw new CatalogMediaError('Invalid image path')
  return path.join(process.cwd(), 'uploads', 'catalog', String(projectId), cardId, filename)
}
export async function readManualCatalogPhoto(projectId: number, cardId: string, filename: string) { return readFile(catalogManualImagePath(projectId, cardId, filename)) }
export async function inspectCatalogUpload(bytes: Buffer) {
  if (!bytes.length || bytes.length > CATALOG_UPLOAD_MAX) throw new CatalogMediaError('Выберите изображение до 10 МБ.')
  const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata().catch(() => null)
  const extension = meta?.format === 'jpeg' ? 'jpg' : meta?.format === 'png' ? 'png' : meta?.format === 'webp' ? 'webp' : null
  if (!extension || (meta?.pages ?? 1) > 1) throw new CatalogMediaError('Разрешены только обычные JPEG, PNG и WebP изображения.')
  // Decode to reject truncated/corrupt files; the decoded pixels are never used to rewrite the upload.
  await sharp(bytes, { limitInputPixels: 40_000_000 }).raw().toBuffer().catch(() => { throw new CatalogMediaError('Файл изображения повреждён.') })
  return { extension, mimeType: extension === 'jpg' ? 'image/jpeg' : `image/${extension}` }
}
export async function attachManualCatalogPhoto(pool: Pool, projectId: number, cardId: string, bytes: Buffer, kind: ManualCatalogPhoto['kind'], slot: number, origin: 'upload' | 'telegram', source?: { sourceItemId: string; sourceIndex: number }) {
  if (!['real','ai','unclassified'].includes(kind) || !Number.isInteger(slot) || slot < 0 || slot > 9 || !['upload','telegram'].includes(origin)) throw new CatalogMediaError('Укажите тип изображения и позицию от 1 до 10.')
  const format = await inspectCatalogUpload(bytes)
  const client = await pool.connect()
  let target = '', written = false, commitSent = false
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`SELECT c.id FROM catalog_cards c JOIN content_factory_items i ON i.id=c.content_item_id AND i.project_id=c.project_id
      JOIN projects p ON p.id=c.project_id WHERE c.id=$1 AND c.project_id=$2 AND i.origin_kind='own' AND p.slug='istraart' AND p.archived_at IS NULL FOR UPDATE OF c`, [cardId, projectId])
    if (!rows[0]) throw new CatalogMediaError('Карточка не найдена в проекте IstraArt.', 404)
    const id = randomUUID()
    const photo: ManualCatalogPhoto = { id, slot, filename: `${id}.${format.extension}`, mimeType: format.mimeType, kind, origin, createdAt: new Date().toISOString(), ...(source ?? {}) }
    target = catalogManualImagePath(projectId, cardId, photo.filename)
    await mkdir(path.dirname(target), { recursive: true })
    try { await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); written = true }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') await unlink(target).catch(() => {}); throw err }
    const saved = await client.query('UPDATE catalog_cards SET manual_media=manual_media || $1::jsonb, updated_at=now() WHERE id=$2 AND project_id=$3 RETURNING manual_media', [JSON.stringify([photo]), cardId, projectId])
    if (!saved.rows[0]) throw new CatalogMediaError('Карточка изменилась. Повторите загрузку.')
    commitSent = true
    await client.query('COMMIT')
    return manualCatalogPhotos(saved.rows[0].manual_media)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    // An uncertain COMMIT must not leave a committed record pointing to a deleted file.
    if (written && !commitSent) await unlink(target).catch(() => {})
    throw err
  } finally { client.release() }
}
export async function importTelegramCatalogPhoto(pool: Pool, projectId: number, cardId: string, itemId: string, index: number, kind: 'real' | 'ai', slot: number) {
  if (!catalogUuid(itemId) || !Number.isInteger(index) || index < 0 || index > 9) throw new CatalogMediaError('Выберите фотографию собственного Telegram-материала.')
  const { rows } = await pool.query("SELECT original_image_files FROM content_factory_items WHERE id=$1 AND project_id=$2 AND origin_kind='own'", [itemId, projectId])
  const filename = rows[0]?.original_image_files?.[index]
  if (typeof filename !== 'string') throw new CatalogMediaError('Исходная фотография не найдена в этом проекте.', 404)
  const bytes = await readOriginalImage(projectId, itemId, filename).catch(() => null)
  if (!bytes) throw new CatalogMediaError('Исходная фотография недоступна.')
  return attachManualCatalogPhoto(pool, projectId, cardId, bytes, kind, slot, 'telegram', { sourceItemId: itemId, sourceIndex: index })
}
export async function readCatalogCardPhoto(projectId: number, cardId: string, itemId: string, files: string[], media: unknown, selection: Record<string,string>, index: number) {
  const id = selection[String(index)]
  if (!id) return readOriginalImage(projectId, itemId, files[index])
  const photo = manualCatalogPhotos(media).find((p) => p.id === id && p.slot === index)
  if (!photo) throw new CatalogMediaError('Выбранное изображение не принадлежит этой карточке.')
  return readManualCatalogPhoto(projectId, cardId, photo.filename)
}
