import type { Pool } from 'pg'
import { createHash } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { createSource } from './content-factory-sources.ts'
import { getItem, storeNewSourceMessages } from './content-factory-items.ts'
import { catalogUuid } from './catalog-manual-photo-data.ts'
import { CatalogMediaError, inspectCatalogUpload } from './catalog-manual-media.ts'
import { writeOriginalImage, readOriginalImage, originalImagePath } from './content-factory-original-images.ts'
const fileOps = { save: writeOriginalImage, read: readOriginalImage, remove: async (project: number, item: string, name: string) => unlink(originalImagePath(project, item, name)) }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** One atomic owner intake, using the same source/item/originals model as the existing bot. */
export async function createManualMaterial(pool: Pool, projectId: number, requestId: string, text: string, photos: Buffer[], files = fileOps) {
  if (!catalogUuid(requestId) || typeof text !== 'string' || !text.trim() || text.length > 10000 || photos.length > 10) throw new CatalogMediaError('Укажите текст до 10 000 символов и не более 10 фотографий.')
  // Reject an invalid last photo before creating any DB row or writing a file.
  for (const bytes of photos) await inspectCatalogUpload(bytes)
  const client = await pool.connect(), db = client as unknown as Pool
  const written: string[] = []; let itemId = '', commitSent = false
  try {
    await client.query('BEGIN')
    const project = await client.query("SELECT id FROM projects WHERE id=$1 AND slug='istraart' AND archived_at IS NULL FOR NO KEY UPDATE", [projectId])
    if (!project.rows[0]) throw new CatalogMediaError('Проект IstraArt недоступен.', 404)
    const handle = 'own-bot:admin', externalId = `admin:${requestId}`
    // The project lock serializes source creation and retries; DB source/external uniqueness is retained.
    const sources = await client.query("SELECT id FROM content_factory_sources WHERE project_id=$1 AND type='telegram' AND handle=$2", [projectId, handle])
    const source = sources.rows[0] ?? await createSource(db, projectId, { type: 'telegram', handle })
    const previous = await client.query('SELECT id FROM content_factory_items WHERE source_id=$1 AND external_id=$2 AND project_id=$3', [source.id, externalId, projectId])
    if (previous.rows[0]) {
      const existing = await getItem(db, projectId, previous.rows[0].id)
      if (!existing || existing.originKind !== 'own' || existing.originalText !== text || existing.originalImageFiles.length !== photos.length) throw new CatalogMediaError('Этот запрос уже сохранён с другими данными. Обновите список материалов.', 409)
      for (let i = 0; i < photos.length; i++) {
        const stored = await files.read(projectId, existing.id, existing.originalImageFiles[i]).catch(() => null)
        if (!stored || hash(stored) !== hash(photos[i])) throw new CatalogMediaError('Сохранённые фотографии отличаются. Обновите список материалов.', 409)
      }
      await client.query('COMMIT')
      return { item: existing, created: false }
    }
    await client.query('UPDATE content_factory_sources SET enabled=false WHERE id=$1 AND project_id=$2', [source.id, projectId])
    const [item] = await storeNewSourceMessages(db, projectId, source.id, [{ externalId, text, url: '', imageUrls: [], publishedAt: '' }])
    if (!item) throw new Error('Insert not confirmed')
    itemId = item.id
    for (const bytes of photos) written.push(await files.save(projectId, itemId, bytes))
    await client.query(`UPDATE content_factory_items SET origin_kind='own', original_image_files=$1::jsonb,
      original_image_urls=$2 WHERE id=$3 AND project_id=$4`, [JSON.stringify(written), written.map((name) => `upload:${name}`).join(','), itemId, projectId])
    const result = await getItem(db, projectId, itemId)
    if (!result) throw new Error('Material not found after insert')
    commitSent = true; await client.query('COMMIT')
    return { item: result, created: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (!commitSent) await Promise.all(written.map((name) => files.remove(projectId, itemId, name).catch(() => {})))
    if (commitSent) throw new CatalogMediaError('Сохранение не подтверждено. Повторите «Сохранить» с теми же данными; новый материал не создавайте.', 503)
    throw error
  } finally { client.release() }
}
