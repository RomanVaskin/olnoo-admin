import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { Pool } from 'pg'
import { originalImagePath, readOriginalImage } from './content-factory-original-images.ts'
import { processedCatalogPhotos, type ProcessedCatalogPhoto } from './catalog-photo-data.ts'

// This is the existing Router's documented inline-image contract, not its text-to-image endpoint.
export const CATALOG_PHOTO_MODEL = 'gemini-3.1-flash-image'
export const CATALOG_PHOTO_PROMPT = `Edit ONLY the supplied owner photograph. Isolate the existing wooden object (driftwood, stump or log) and replace only its surroundings with a neutral uniform light-grey #F5F5F3 studio background and a soft natural contact shadow.
Preserve the EXACT existing silhouette, proportions, branches, holes, cracks, texture, grain and natural wood colour. Preserve the camera angle and aspect ratio. Keep the whole object visible. Do not invent or remove object details, reshape, smooth, polish, recolour or beautify the wood. Do not generate a new product or add hardware, decorations, text, a logo or watermark. If a detail is hidden in the photo, do not fabricate it. Return only the edited photograph. The result will be compared with the original by a human.`
const MAX = 10 * 1024 * 1024
export class CatalogPhotoError extends Error {}
export function processedCatalogPhotoPath(projectId: number, itemId: string, filename: string): string {
  // Reuse the existing IDs/filename path checks, with a separate sibling directory.
  const original = originalImagePath(projectId, itemId, filename)
  return path.join(process.cwd(), 'uploads', 'content-factory', 'processed', String(projectId), itemId, path.basename(original))
}
export async function readProcessedCatalogPhoto(projectId: number, itemId: string, filename: string) {
  return readFile(processedCatalogPhotoPath(projectId, itemId, filename))
}

export async function editCatalogPhoto(bytes: Buffer, fetchImpl: typeof fetch = fetch): Promise<{ bytes: Buffer; model: string }> {
  const token = process.env.OLNOO_ROUTER_TOKEN
  if (!token) throw new CatalogPhotoError('AI Router не настроен. Обратитесь к администратору.')
  if (!bytes.length || bytes.length > MAX) throw new CatalogPhotoError('Исходное фото должно быть не больше 10 МБ.')
  const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata().catch(() => null)
  const mime = meta?.format === 'jpeg' ? 'image/jpeg' : meta?.format === 'png' ? 'image/png' : meta?.format === 'webp' ? 'image/webp' : null
  if (!mime) throw new CatalogPhotoError('Исходное фото должно быть JPEG, PNG или WebP.')
  const base = process.env.AI_ROUTER_URL || 'http://127.0.0.1:3010'
  const headers = { 'Content-Type': 'application/json', 'x-api-key': token }
  try {
    const providers = await fetchImpl(`${base}/providers`, { headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!providers.ok) throw new CatalogPhotoError('Не удалось проверить модель обработки в AI Router.')
    const catalog = await providers.json()
    if (!catalog.providers?.some((p: { name: string; models: { id: string }[] }) => p.name === 'gemini' && p.models?.some((m) => m.id === CATALOG_PHOTO_MODEL))) {
      throw new CatalogPhotoError(`Модель ${CATALOG_PHOTO_MODEL} не подключена в AI Router. Нужна настройка существующего Gemini allow-list; обработка не запущена.`)
    }
    const response = await fetchImpl(`${base}/api/images/generate`, {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ provider: 'gemini', model: CATALOG_PHOTO_MODEL, prompt: CATALOG_PHOTO_PROMPT, images: [{ mimeType: mime, data: bytes.toString('base64'), label: 'Owner original: preserve the wooden object exactly' }] }),
    })
    if (!response.ok) throw new CatalogPhotoError(`AI Router не обработал фото (HTTP ${response.status}). Оригинал сохранён.`)
    // Bound the response before JSON/base64 allocation; no raw upstream errors are exposed.
    if (!response.body) throw new CatalogPhotoError('AI Router вернул пустой ответ.')
    const reader = response.body.getReader(), chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > 16 * 1024 * 1024) throw new CatalogPhotoError('Ответ AI Router слишком большой.')
        chunks.push(Buffer.from(part.value))
      }
    } finally { await reader.cancel().catch(() => {}) }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (result.provider !== 'gemini' || result.model !== CATALOG_PHOTO_MODEL || typeof result.imageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.imageBase64)) throw new CatalogPhotoError('Некорректный результат обработки AI Router.')
    const image = Buffer.from(result.imageBase64, 'base64')
    if (!image.length || image.length > MAX) throw new CatalogPhotoError('Обработанное фото превышает лимит 10 МБ.')
    const metadata = await sharp(image, { limitInputPixels: 40_000_000 }).metadata()
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.mimeType) || `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}` !== result.mimeType) throw new CatalogPhotoError('AI Router вернул неподдерживаемое изображение.')
    // PNG storage, lossless; the original bytes are never rewritten or re-encoded.
    const png = await sharp(image).png().toBuffer()
    if (png.length > MAX) throw new CatalogPhotoError('Обработанное фото превышает лимит 10 МБ.')
    return { bytes: png, model: result.model }
  } catch (error) {
    if (error instanceof CatalogPhotoError) throw error
    throw new CatalogPhotoError('Не удалось обработать фото. Оригинал и предыдущие версии сохранены.')
  }
}

export async function processCatalogPhoto(pool: Pool, projectId: number, itemId: string, originalIndex: number, edit = editCatalogPhoto) {
  if (!Number.isInteger(originalIndex) || originalIndex < 0 || originalIndex > 9) throw new CatalogPhotoError('Выберите исходное фото.')
  const { rows } = await pool.query("SELECT original_image_files, processed_image_versions FROM content_factory_items WHERE id = $1 AND project_id = $2 AND origin_kind = 'own'", [itemId, projectId])
  const filename = rows[0]?.original_image_files?.[originalIndex]
  if (typeof filename !== 'string') throw new CatalogPhotoError('Исходное фото не найдено в этом проекте.')
  const original = await readOriginalImage(projectId, itemId, filename).catch(() => null)
  if (!original) throw new CatalogPhotoError('Исходное фото недоступно. Предыдущие версии сохранены.')
  const output = await edit(original)
  const id = randomUUID()
  const record: ProcessedCatalogPhoto = { id, originalIndex, originalFilename: filename, filename: `${id}.png`, provider: 'gemini', model: output.model, createdAt: new Date().toISOString() }
  const target = processedCatalogPhotoPath(projectId, itemId, record.filename)
  await mkdir(path.dirname(target), { recursive: true })
  try { await writeFile(target, output.bytes, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await unlink(target).catch(() => {})
    throw error
  }
  try {
    const saved = await pool.query(`UPDATE content_factory_items SET processed_image_versions = processed_image_versions || $1::jsonb
      WHERE id = $2 AND project_id = $3 AND origin_kind = 'own' AND original_image_files ->> $4::int = $5 RETURNING id`, [JSON.stringify([record]), itemId, projectId, originalIndex, filename])
    if (!saved.rows[0]) throw new CatalogPhotoError('Материал изменился. Оригинал и прежние версии сохранены; обновите карточку.')
  } catch (error) { await unlink(target).catch(() => {}); throw error }
  return record
}

export async function readCatalogSelectedPhoto(projectId: number, itemId: string, index: number, files: string[], history: unknown, versions: Record<string, string> = {}) {
  const version = versions[String(index)]
  if (!version) return readOriginalImage(projectId, itemId, files[index])
  const record = processedCatalogPhotos(history).find((v) => v.id === version && v.originalIndex === index && v.originalFilename === files[index])
  if (!record) throw new CatalogPhotoError('Выбранная версия не принадлежит этому исходному фото.')
  return readProcessedCatalogPhoto(projectId, itemId, record.filename)
}
