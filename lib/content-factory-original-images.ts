import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'
import type { ContentFactoryItem } from './content-factory-items.ts'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const RETRY_DELAYS_MS = [250, 750]
const FILE = /^[0-9a-f-]{36}\.(?:jpg|png|webp)$/
const ITEM = /^[0-9a-f-]{36}$/
const ROOT = path.join(process.cwd(), 'uploads', 'content-factory', 'originals')

export class ContentFactoryOriginalImageError extends Error {}

export function originalImagePath(projectId: number, itemId: string, filename: string): string {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !ITEM.test(itemId) || !FILE.test(filename)) {
    throw new ContentFactoryOriginalImageError('Invalid original image path.')
  }
  return path.join(ROOT, String(projectId), itemId, filename)
}

function telegramImageUrl(raw: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new ContentFactoryOriginalImageError('Telegram image has an invalid URL.') }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password ||
      !(host === 'telesco.pe' || host.endsWith('.telesco.pe') || host === 'telegram-cdn.org' ||
        host.endsWith('.telegram-cdn.org') || host === 'cdn-telegram.org' || host.endsWith('.cdn-telegram.org'))) {
    throw new ContentFactoryOriginalImageError('Image URL is not on an allowed Telegram media host.')
  }
  return url.href
}

function imageExtension(bytes: Buffer): 'jpg' | 'png' | 'webp' {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  throw new ContentFactoryOriginalImageError('Telegram media is not a supported JPEG, PNG or WebP image.')
}

export async function downloadOriginalImage(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<{ bytes: Buffer; extension: 'jpg' | 'png' | 'webp' }> {
  const url = telegramImageUrl(rawUrl)
  let response: Response
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) throw error
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
      continue
    }
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt >= RETRY_DELAYS_MS.length) break
    await response.body?.cancel().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
  }
  if (!response.ok) throw new ContentFactoryOriginalImageError(`Telegram image download failed (HTTP ${response.status}).`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_IMAGE_BYTES) throw new ContentFactoryOriginalImageError('Telegram image exceeds the 10 MB photo limit.')
  if (!response.body) throw new ContentFactoryOriginalImageError('Telegram image response is empty.')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_IMAGE_BYTES) throw new ContentFactoryOriginalImageError('Telegram image exceeds the 10 MB photo limit.')
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  const bytes = Buffer.concat(chunks)
  return { bytes, extension: imageExtension(bytes) }
}

export async function readOriginalImage(projectId: number, itemId: string, filename: string): Promise<Buffer> {
  return readFile(originalImagePath(projectId, itemId, filename))
}

/** Persist each successful image in source order. A later failure leaves previous files and
 * original URLs intact; a manual retry resumes at the first missing index. */
export async function syncOriginalImages(pool: Pool, item: ContentFactoryItem, fetchImpl: typeof fetch = fetch, freshImageUrls?: string[]): Promise<string> {
  if (item.processingMode !== 'copy') return ''
  const files = [...item.originalImageFiles]
  if (files.length > item.originalImageUrls.length || item.originalImageUrls.length > 10) {
    const error = 'Telegram photo album must contain at most 10 images.'
    await pool.query('UPDATE content_factory_items SET original_image_error = $1 WHERE id = $2 AND project_id = $3', [error, item.id, item.projectId])
    return error
  }
  if (freshImageUrls && freshImageUrls.length !== item.originalImageUrls.length) {
    const error = 'The source post now shows a different number of photos. Compare the original post before retrying; the saved album was kept.'
    await pool.query('UPDATE content_factory_items SET original_image_error = $1 WHERE id = $2 AND project_id = $3', [error, item.id, item.projectId])
    return error
  }
  for (let index = files.length; index < item.originalImageUrls.length; index++) {
    let filename = ''
    let target = ''
    try {
      const { bytes, extension } = await downloadOriginalImage(freshImageUrls?.[index] ?? item.originalImageUrls[index], fetchImpl)
      filename = `${randomUUID()}.${extension}`
      target = originalImagePath(item.projectId, item.id, filename)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes, { flag: 'wx' })
      const { rowCount } = await pool.query(
        `UPDATE content_factory_items SET original_image_files = original_image_files || to_jsonb($1::text),
         original_image_error = '', updated_at = now()
         WHERE id = $2 AND project_id = $3 AND processing_mode = 'copy'
           AND jsonb_array_length(original_image_files) = $4`, [filename, item.id, item.projectId, index],
      )
      if (rowCount !== 1) {
        await unlink(target).catch(() => {})
        const error = 'Material changed while saving source images. Retry the source check.'
        await pool.query('UPDATE content_factory_items SET original_image_error = $1 WHERE id = $2 AND project_id = $3', [error, item.id, item.projectId])
        return error
      }
      files.push(filename)
    } catch (err) {
      if (target) await unlink(target).catch(() => {})
      const error = `Source image ${index + 1}/${item.originalImageUrls.length}: ${err instanceof Error ? err.message : 'download failed'}`
      await pool.query('UPDATE content_factory_items SET original_image_error = $1 WHERE id = $2 AND project_id = $3', [error, item.id, item.projectId])
      return error
    }
  }
  if (item.originalImageError) await pool.query('UPDATE content_factory_items SET original_image_error = \'\' WHERE id = $1 AND project_id = $2', [item.id, item.projectId])
  return ''
}
