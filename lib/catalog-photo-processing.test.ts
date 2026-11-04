import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { Pool } from 'pg'
import { originalImagePath } from './content-factory-original-images.ts'
import { editCatalogPhoto, processCatalogPhoto, processedCatalogPhotoPath, readProcessedCatalogPhoto, CATALOG_PHOTO_MODEL, CATALOG_PHOTO_PROMPT } from './catalog-photo-processing.ts'
import { catalogPhotoVersionsValid, type ProcessedCatalogPhoto } from './catalog-photo-data.ts'
import { catalogPhotoSelection, catalogPublicProjection } from './catalog-export.ts'
import { catalogCardErrors, publicCatalogCard } from './catalog-card.ts'

const png = () => sharp({ create: { width: 12, height: 8, channels: 3, background: '#887766' } }).png().toBuffer()
test('inline source photo uses the real Gemini Router contract, with no fallback or key exposure', async () => {
  const previous = process.env.OLNOO_ROUTER_TOKEN
  const token = 'synthetic-private-router-token'
  process.env.OLNOO_ROUTER_TOKEN = token
  try {
    const image = await png(), before = Buffer.from(image)
    const calls: string[] = []
    const result = await editCatalogPhoto(image, async (url, init) => {
      calls.push(String(url))
      assert.equal(new Headers(init?.headers).get('x-api-key'), token)
      assert.equal(init?.redirect, 'error')
      if (String(url).endsWith('/providers')) return Response.json({ providers: [{ name: 'gemini', models: [{ id: CATALOG_PHOTO_MODEL }] }] })
      assert.ok(String(url).endsWith('/api/images/generate'))
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, CATALOG_PHOTO_MODEL)
      assert.equal(body.provider, 'gemini')
      assert.equal(body.images.length, 1)
      assert.equal(body.images[0].mimeType, 'image/png')
      assert.deepEqual(Buffer.from(body.images[0].data, 'base64'), before)
      assert.equal(body.prompt, CATALOG_PHOTO_PROMPT)
      assert.ok(body.prompt.includes('#F5F5F3'))
      assert.ok(body.prompt.includes('soft natural contact shadow'))
      assert.ok(body.prompt.includes('EXACT existing silhouette'))
      assert.equal(String(init?.body).includes(token), false)
      assert.equal(body.allowFallback, undefined, 'do not invent a field unsupported by this endpoint')
      return Response.json({ provider: 'gemini', model: CATALOG_PHOTO_MODEL, mimeType: 'image/png', imageBase64: image.toString('base64') })
    })
    assert.equal(calls.length, 2)
    assert.deepEqual(image, before)
    assert.equal(result.model, CATALOG_PHOTO_MODEL)
    assert.equal((await sharp(result.bytes).metadata()).format, 'png')
    let generated = false
    await assert.rejects(() => editCatalogPhoto(image, async (url) => {
      if (!String(url).endsWith('/providers')) generated = true
      return Response.json({ providers: [] })
    }), /не подключена/)
    assert.equal(generated, false)
    const providers = () => Response.json({ providers: [{ name: 'gemini', models: [{ id: CATALOG_PHOTO_MODEL }] }] })
    for (const response of [() => new Response('private upstream detail', { status: 502 }), () => Response.json({ mimeType: 'image/png', imageBase64: 'not-an-image' }), () => Response.json({ provider: 'gemini', model: CATALOG_PHOTO_MODEL, mimeType: 'image/png', imageBase64: Buffer.from('invalid image').toString('base64') })]) {
      await assert.rejects(() => editCatalogPhoto(image, async (url) => String(url).endsWith('/providers') ? providers() : response()))
    }
    await assert.rejects(() => editCatalogPhoto(image, async () => { throw new Error(token) }), (err: Error) => !err.message.includes(token))
  } finally { if (previous === undefined) delete process.env.OLNOO_ROUTER_TOKEN; else process.env.OLNOO_ROUTER_TOKEN = previous }
})

test('reprocessing appends versions, preserves original bytes and rolls back only a newly written file on failure', async () => {
  const itemId = randomUUID(), projectId = 987654, filename = `${randomUUID()}.png`
  const original = originalImagePath(projectId, itemId, filename)
  const source = await png()
  await mkdir(path.dirname(original), { recursive: true }); await writeFile(original, source, { flag: 'wx' })
  const processedDir = path.dirname(processedCatalogPhotoPath(projectId, itemId, `${randomUUID()}.png`))
  let history: ProcessedCatalogPhoto[] = [], rejectSave = false
  const db = { query: async (sql: string, args: unknown[]) => {
    assert.equal(args[sql.startsWith('SELECT') ? 0 : 1], itemId)
    assert.equal(args[sql.startsWith('SELECT') ? 1 : 2], projectId)
    assert.match(sql, /origin_kind = 'own'/)
    if (sql.startsWith('SELECT')) return { rows: [{ original_image_files: [filename], processed_image_versions: history }] }
    assert.match(sql, /SET processed_image_versions = processed_image_versions \|\|/)
    assert.equal(args[4], filename)
    if (rejectSave) return { rows: [] }
    history = [...history, ...JSON.parse(String(args[0]))]
    return { rows: [{ id: itemId }] }
  } } as unknown as Pool
  try {
    const edit = async (input: Buffer) => { assert.deepEqual(input, source); return { bytes: await png(), model: CATALOG_PHOTO_MODEL } }
    const a = await processCatalogPhoto(db, projectId, itemId, 0, edit)
    const b = await processCatalogPhoto(db, projectId, itemId, 0, edit)
    assert.notEqual(a.id, b.id)
    assert.equal(history.length, 2)
    assert.deepEqual(await readProcessedCatalogPhoto(projectId, itemId, a.filename), await png())
    assert.deepEqual(await readProcessedCatalogPhoto(projectId, itemId, b.filename), await png())
    await assert.rejects(() => processCatalogPhoto(db, projectId, itemId, 0, async () => { throw new Error('provider failure') }))
    rejectSave = true
    await assert.rejects(() => processCatalogPhoto(db, projectId, itemId, 0, edit), /Материал изменился/)
    assert.equal(history.length, 2)
    assert.equal((await readdir(processedDir)).length, 2)
    assert.equal(createHash('sha256').update(await readFile(original)).digest('hex'), createHash('sha256').update(source).digest('hex'))
    assert.equal(catalogPhotoVersionsValid({ 0: a.id }, [filename], history), true)
    assert.equal(catalogPhotoVersionsValid({ 0: a.id }, [`${randomUUID()}.png`], history), false)
    assert.equal(catalogPhotoVersionsValid({ 1: a.id }, [filename, filename], history), false)
    assert.equal(catalogPhotoVersionsValid({ 0: a.id }, [filename], []), false)
  } finally {
    await rm(path.dirname(original), { recursive: true, force: true }); await rm(processedDir, { recursive: true, force: true })
  }
})

test('public photos resolve only the selected version of this card/source; originals remain the default', () => {
  const version = randomUUID(), filename = `${randomUUID()}.png`
  const record = { id: version, originalIndex: 0, originalFilename: filename, filename: `${version}.png`, provider: 'gemini', model: CATALOG_PHOTO_MODEL, createdAt: '2026-11-04T00:00:00Z' }
  const row = { id: randomUUID(), slug: 'wood', title: 'Дерево', description: '', length_cm: null, diameter_cm: null, card_kind: 'raw',
    offers: { raw: { title: 'Материал', description: 'Подтверждено', priceRub: 1500, available: true, imageIndexes: [0] } },
    published_at: '2026-11-04', updated_at: '2026-11-04', origin_kind: 'own', project_id: 7, item_id: randomUUID(), original_image_files: [filename], original_image_urls: 'file:original', original_image_error: '', processed_image_versions: [record], photo_versions: { 0: version } }
  assert.deepEqual(catalogPhotoSelection(row, 0), { projectId: 7, itemId: row.item_id, filename: `${version}.png`, processed: true })
  assert.equal(catalogPhotoSelection({ ...row, published_at: null }, 0), null)
  assert.equal(catalogPhotoSelection({ ...row, processed_image_versions: [] }, 0), null)
  assert.equal(catalogPhotoSelection(row, 1), null)
  assert.deepEqual(catalogPhotoSelection({ ...row, photo_versions: {} }, 0), { projectId: 7, itemId: row.item_id, filename })
  const dto = JSON.stringify(catalogPublicProjection(row))
  for (const internal of ['photoVersions', 'photo_versions', 'processed_image_versions', version, filename, 'originalFilename']) assert.equal(dto.includes(internal), false)
  const input = { slug: 'wood', title: 'Дерево', description: '', lengthCm: null, diameterCm: null, offers: row.offers, photoVersions: { 0: version } }
  assert.equal(JSON.stringify(publicCatalogCard(input)).includes('photoVersions'), false)
  assert.deepEqual(catalogCardErrors(input, 1), {})
  assert.ok(catalogCardErrors({ ...input, offers: {} }, 1).photoVersions)
})
