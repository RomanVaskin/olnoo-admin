import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { Pool } from 'pg'
import { ISTRAART_STYLE_DEFAULT, buildIstraArtChatGptPrompt, validateIstraArtStyle } from './istraart-style.ts'
import { getIstraArtStyle, saveIstraArtStyle } from './istraart-style-store.ts'
import { attachManualCatalogPhoto, catalogManualImagePath, importTelegramCatalogPhoto, inspectCatalogUpload, readManualCatalogPhoto } from './catalog-manual-media.ts'
import { manualPhotoCount, manualPhotoSelectionValid, type ManualCatalogPhoto } from './catalog-manual-photo-data.ts'
import { originalImagePath, writeOriginalImage } from './content-factory-original-images.ts'
import { catalogPhotoSelection, catalogPublicProjection } from './catalog-export.ts'
import { publicCatalogCard, publishableCatalogCard } from './catalog-card.ts'

const card = { slug: 'wood', title: 'Коряга владельца', description: 'Только согласованная идея', lengthCm: 45, diameterCm: null, offers: {} }
test('one editable style is saved for IstraArt only; copy context preserves actual measurements without prices', async () => {
  let saved: string | null = null
  const pool = { query: async (sql: string, values?: unknown[]) => {
    assert.match(sql, /slug='istraart' AND archived_at IS NULL/)
    if (sql.startsWith('UPDATE')) saved = String(values![0])
    return { rows: [{ istraart_style_prompt: saved }] }
  } } as unknown as Pool
  assert.equal(await getIstraArtStyle(pool), ISTRAART_STYLE_DEFAULT)
  assert.equal(await saveIstraArtStyle(pool, '  Владелец изменил единый стиль  '), 'Владелец изменил единый стиль')
  assert.equal(await getIstraArtStyle(pool), 'Владелец изменил единый стиль')
  assert.throws(() => validateIstraArtStyle('   '))
  assert.throws(() => validateIstraArtStyle('a'.repeat(16001)))
  for (const [task, label] of [['raw', 'ИСХОДНЫЙ МАТЕРИАЛ'], ['finished', 'ГОТОВОЕ ИЗДЕЛИЕ'], ['guide', 'DIY-ГАЙД']] as const) {
    const prompt = buildIstraArtChatGptPrompt(ISTRAART_STYLE_DEFAULT, task, card, 'Сведения владельца')
    assert.ok(prompt.includes(`ВЫБРАННАЯ ЗАДАЧА: ${label}`))
    assert.ok(prompt.includes('45 см (указано владельцем)'))
    assert.ok(prompt.includes('не подтверждено — уточни'))
    assert.ok(prompt.includes('Сведения владельца'))
    for (const text of ['Premium Minimalism', 'Japandi', 'Quiet Luxury', '4:5', '#F5F5F3', 'камень', 'лён', 'геометрию', 'технические характеристики']) assert.ok(prompt.includes(text))
    assert.equal(prompt.includes('/api/'), false)
  }
  assert.ok(buildIstraArtChatGptPrompt('Изменённый стиль', 'finished', { ...card, title: 'Ручная правка', lengthCm: 53 }, '').includes('53 см'))
})

test('Admin uploads and Telegram imports store immutable originals on one card, with explicit real/AI labels', async () => {
  const projectId = 987653, cardId = randomUUID(), itemId = randomUUID()
  const image = await sharp({ create: { width: 8, height: 10, channels: 3, background: '#a98' } }).png().toBuffer()
  const original = await writeOriginalImage(projectId, itemId, image)
  let media: ManualCatalogPhoto[] = [], snapshot: ManualCatalogPhoto[] = []
  let fail = false
  const query = async (sql: string, args: unknown[] = []) => {
    if (sql === 'BEGIN') { snapshot = [...media]; return { rows: [] } }
    if (sql === 'ROLLBACK') { media = snapshot; return { rows: [] } }
    if (sql === 'COMMIT') return { rows: [] }
    if (sql.includes('SELECT original_image_files')) return { rows: args[0] === itemId && args[1] === projectId ? [{ original_image_files: [original] }] : [] }
    if (sql.includes('SELECT c.id')) { assert.match(sql, /p.slug='istraart'/); return { rows: args[0] === cardId && args[1] === projectId ? [{ id: cardId }] : [] } }
    assert.match(sql, /SET manual_media=manual_media \|\|/)
    assert.equal(sql.includes('published_at'), false)
    if (fail) throw new Error('simulated save failure')
    media = [...media, ...JSON.parse(String(args[0]))]
    return { rows: [{ manual_media: media }] }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool
  try {
    await attachManualCatalogPhoto(pool, projectId, cardId, image, 'ai', 0, 'upload')
    await importTelegramCatalogPhoto(pool, projectId, cardId, itemId, 0, 'real', 0)
    assert.equal(media.length, 2)
    assert.notEqual(media[0].id, media[1].id)
    assert.deepEqual(media.map((p) => [p.kind, p.origin]), [['ai', 'upload'], ['real', 'telegram']])
    assert.equal(media[1].sourceItemId, itemId)
    for (const photo of media) assert.deepEqual(await readManualCatalogPhoto(projectId, cardId, photo.filename), image)
    assert.deepEqual(await readFile(originalImagePath(projectId, itemId, original)), image)
    await assert.rejects(() => importTelegramCatalogPhoto(pool, projectId + 1, cardId, itemId, 0, 'real', 0), /не найдена/)
    await assert.rejects(() => attachManualCatalogPhoto(pool, projectId, randomUUID(), image, 'real', 0, 'upload'), /не найдена/)
    await assert.rejects(() => readManualCatalogPhoto(projectId, randomUUID(), media[0].filename))
    fail = true
    await assert.rejects(() => attachManualCatalogPhoto(pool, projectId, cardId, image, 'ai', 0, 'upload'))
    assert.equal(media.length, 2)
    for (const photo of media) assert.deepEqual(await readManualCatalogPhoto(projectId, cardId, photo.filename), image)
    await assert.rejects(() => inspectCatalogUpload(Buffer.from('<svg></svg>')))
    await assert.rejects(() => inspectCatalogUpload(Buffer.alloc(10 * 1024 * 1024 + 1)))
  } finally {
    await rm(path.dirname(catalogManualImagePath(projectId, cardId, `${randomUUID()}.png`)), { recursive: true, force: true })
    await rm(path.dirname(originalImagePath(projectId, itemId, original)), { recursive: true, force: true })
  }
})

test('manual file selection is per-card and preserves the public DTO and old original photos', () => {
  const id = randomUUID(), asset = { id, filename: `${id}.png`, slot: 0, kind: 'ai' as const, mimeType: 'image/png', origin: 'upload' as const, createdAt: '2026-11-04T00:00:00Z' }
  const input = { ...card, offers: { finished: { title: 'Изделие', description: 'Описание владельца', priceRub: 5000, available: true, imageIndexes: [0] } }, manualPhotoSelection: { 0: id } }
  const row = { id: randomUUID(), project_id: 7, item_id: randomUUID(), ...card, length_cm: 45, diameter_cm: null, offers: input.offers, published_at: '2026-11-04', updated_at: '2026-11-04', origin_kind: 'own', card_kind: 'finished', original_image_files: [], original_image_urls: '', original_image_error: '', manual_media: [asset], manual_photo_selection: input.manualPhotoSelection }
  assert.equal(manualPhotoCount([], [asset]), 1)
  assert.equal(manualPhotoSelectionValid(input, [], [asset]), true)
  assert.equal(publishableCatalogCard(input, 1, 'finished'), true)
  assert.equal(manualPhotoSelectionValid(input, [], []), false)
  assert.equal(manualPhotoSelectionValid({ ...input, manualPhotoSelection: {} }, [], [asset]), false)
  assert.equal(manualPhotoSelectionValid({ ...input, manualPhotoSelection: { 1: id } }, [], [asset]), false)
  assert.deepEqual(catalogPhotoSelection(row, 0), { projectId: 7, cardId: row.id, itemId: row.item_id, filename: asset.filename, manual: true })
  assert.equal(catalogPhotoSelection({ ...row, published_at: null }, 0), null)
  assert.equal(catalogPhotoSelection({ ...row, manual_media: [] }, 0), null)
  assert.equal(catalogPhotoSelection(row, 1), null)
  for (const hidden of [id, asset.filename, 'manual_media', 'manualPhotoSelection', 'sourceItemId']) assert.equal(JSON.stringify(catalogPublicProjection(row)).includes(hidden), false)
  assert.equal(JSON.stringify(publicCatalogCard(input)).includes('manualPhotoSelection'), false)
  const legacy = { ...row, manual_media: [], manual_photo_selection: {}, original_image_files: ['original.jpg'], original_image_urls: 'file:original' }
  assert.deepEqual(catalogPhotoSelection(legacy, 0), { projectId: 7, itemId: row.item_id, filename: 'original.jpg' })
})
