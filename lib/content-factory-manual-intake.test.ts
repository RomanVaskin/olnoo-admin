import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import sharp from 'sharp'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as cardData from './catalog-card.ts'
import * as photoData from './catalog-manual-photo-data.ts'
import * as schema from './catalog-schema.ts'
import { catalogInputFromRow, catalogPublicProjection } from './catalog-export.ts'
import { createManualMaterial } from './content-factory-manual-intake.ts'
import { CatalogMediaError } from './catalog-manual-media.ts'
import { originalImagePath, readOriginalImage } from './content-factory-original-images.ts'
const projectId = 987661, requestId = '00000000-0000-4000-8000-000000000001'
const image = () => sharp({ create: { width: 8, height: 10, channels: 3, background: '#aa9988' } }).png().toBuffer()
function harness({ failFile = 0, failCommit = false, active = true, failUpdate = false } = {}) {
  let sources: any[] = [], items: any[] = [], tail = Promise.resolve(), writes = 0, removes = 0
  const bytes = new Map<string, Buffer>(), queries: string[] = []
  const pool = { connect: async () => {
    let snapshot: any, committed = false, unlock: (() => void) | undefined
    const release = () => { unlock?.(); unlock = undefined }
    const query = async (sql: string, args: any[] = []) => {
      queries.push(sql)
      if (sql === 'BEGIN') return { rows: [] }
      if (sql === 'COMMIT') { committed = true; release(); if (failCommit) { failCommit = false; throw new Error('response lost after commit') }; return { rows: [] } }
      if (sql === 'ROLLBACK') { if (!committed && snapshot) { sources = snapshot.sources; items = snapshot.items }; release(); return { rows: [] } }
      if (sql.includes('FROM projects')) {
        assert.match(sql, /slug='istraart'.*archived_at IS NULL FOR NO KEY UPDATE/)
        const previous = tail; tail = new Promise<void>((resolve) => { unlock = resolve }); await previous
        snapshot = structuredClone({ sources, items })
        return { rows: active && args[0] === projectId ? [{ id: projectId }] : [] }
      }
      if (sql.includes('INSERT INTO content_factory_sources')) { const row = { id: args[0], project_id: args[1], type: args[2], handle: args[3], enabled: true, processing_mode: args[4] }; sources.push(row); return { rows: [row] } }
      if (sql.includes('FROM content_factory_sources')) return { rows: sources.filter((s) => s.project_id === args[0] && s.handle === args[1]) }
      if (sql.includes('UPDATE content_factory_sources')) { const source = sources.find((s) => s.id === args[0] && s.project_id === args[1]); source.enabled = false; return { rows: [] } }
      if (sql.includes('INSERT INTO content_factory_items')) {
        if (items.some((i) => i.source_id === args[2] && i.external_id === args[3])) return { rows: [] }
        const row = { id: args[0], project_id: args[1], source_id: args[2], external_id: args[3], original_url: args[4], original_text: args[5], original_image_urls: args[6], status: args[8], generated_text: args[9], review_reason: args[10], processing_mode: args[11], copy_permission_confirmed: args[12], source_language: args[13], origin_kind: 'source', original_image_files: [], ai_review: null, created_at: '2026-11-05T00:00:00Z' }
        items.push(row); return { rows: [structuredClone(row)] }
      }
      if (sql.includes('UPDATE content_factory_items')) {
        if (failUpdate) throw new Error('metadata failed')
        const row = items.find((i) => i.id === args[2] && i.project_id === args[3]); Object.assign(row, { origin_kind: 'own', original_image_files: JSON.parse(args[0]), original_image_urls: args[1] }); return { rows: [row] }
      }
      if (sql.includes('WHERE source_id=')) return { rows: items.filter((i) => i.source_id === args[0] && i.external_id === args[1] && i.project_id === args[2]) }
      if (sql.includes('SELECT * FROM content_factory_items')) return { rows: structuredClone(items.filter((i) => i.id === args[0] && i.project_id === args[1])) }
      throw new Error('Unexpected SQL '+sql)
    }
    return { query, release }
  } } as unknown as Pool
  const files = {
    save: async (_project: number, item: string, value: Buffer) => { writes++; if (writes === failFile) throw new Error('disk error'); const name = `file-${writes}.png`; bytes.set(`${item}/${name}`, Buffer.from(value)); return name },
    read: async (_project: number, item: string, name: string) => { const value = bytes.get(`${item}/${name}`); if (!value) throw new Error('missing'); return value },
    remove: async (_project: number, item: string, name: string) => { removes++; bytes.delete(`${item}/${name}`) },
  }
  return { pool, files, state: () => ({ sources, items, writes, removes, files: bytes.size }), queries }
}

test('manual own intake saves exact text/photos, returns new DTO, reopens idempotently and uses immutable original storage', async () => {
  const h = harness(), png = await image(), text = '  Коряга!\nРазмер уточняется. 🌿  '
  const created = await createManualMaterial(h.pool, projectId, requestId, text, [png], h.files)
  assert.equal(created.created, true); assert.equal(created.item.originKind, 'own'); assert.equal(created.item.status, 'new')
  assert.equal(created.item.originalText, text); assert.equal(created.item.generatedText, ''); assert.equal(created.item.aiReview, null)
  assert.equal(created.item.originalImageFiles.length, 1)
  assert.deepEqual(await h.files.read(projectId, created.item.id, created.item.originalImageFiles[0]), png)
  const again = await createManualMaterial(h.pool, projectId, requestId, text, [png], h.files)
  assert.equal(again.created, false); assert.equal(again.item.id, created.item.id); assert.equal(h.state().items.length, 1); assert.equal(h.state().writes, 1)
  assert.equal(h.state().sources.length, 1); assert.equal(h.state().sources[0].enabled, false); assert.equal(h.state().sources[0].handle, 'own-bot:admin')
  assert.ok(h.queries.every((sql) => !/catalog_cards|social_posts|social_publications/i.test(sql)))
  await assert.rejects(() => createManualMaterial(h.pool, projectId, requestId, 'Changed', [png], h.files), (error: any) => error.status === 409)
  assert.equal(h.state().items[0].original_text, text)
  const real = harness()
  const saved = await createManualMaterial(real.pool, projectId, requestId, text, [png])
  try { assert.deepEqual(await readOriginalImage(projectId, saved.item.id, saved.item.originalImageFiles[0]), png) }
  finally { await rm(path.dirname(originalImagePath(projectId, saved.item.id, saved.item.originalImageFiles[0])), { recursive: true, force: true }) }
})

test('invalid photos/text and a later save error never leave an empty material; earlier new files are cleaned', async () => {
  const png = await image()
  for (const input of [{ text: ' ', photos: [] }, { text: 'text', photos: [png, Buffer.from('corrupt')] }, { text: 'text', photos: [Buffer.alloc(10 * 1024 * 1024 + 1)] }, { text: 'text', photos: Array(11).fill(png) }]) {
    const h = harness()
    await assert.rejects(() => createManualMaterial(h.pool, projectId, requestId, input.text, input.photos, h.files))
    assert.deepEqual(h.state(), { sources: [], items: [], writes: 0, removes: 0, files: 0 })
  }
  for (const options of [{ failFile: 2 }, { failUpdate: true }]) {
    const h = harness(options)
    await assert.rejects(() => createManualMaterial(h.pool, projectId, requestId, 'text', [png,png], h.files))
    assert.equal(h.state().items.length, 0); assert.equal(h.state().sources.length, 0); assert.equal(h.state().files, 0)
    assert.ok(h.state().removes > 0)
  }
  const inactive = harness({ active: false })
  await assert.rejects(() => createManualMaterial(inactive.pool, projectId, requestId, 'text', [], inactive.files), (error: any) => error.status === 404)
  assert.equal(inactive.state().items.length, 0)
})

test('simultaneous saves and uncertain commit reuse the same complete material without duplicate files', async () => {
  const png = await image(), h = harness()
  const results = await Promise.all([createManualMaterial(h.pool, projectId, requestId, 'text', [png], h.files), createManualMaterial(h.pool, projectId, requestId, 'text', [png], h.files)])
  assert.equal(results[0].item.id, results[1].item.id); assert.equal(h.state().items.length, 1); assert.equal(h.state().writes, 1)
  const uncertain = harness({ failCommit: true })
  await assert.rejects(() => createManualMaterial(uncertain.pool, projectId, requestId, 'text', [png], uncertain.files), (error: any) => error.status === 503)
  assert.equal(uncertain.state().items.length, 1); assert.equal(uncertain.state().files, 1)
  const retry = await createManualMaterial(uncertain.pool, projectId, requestId, 'text', [png], uncertain.files)
  assert.equal(retry.created, false); assert.equal(uncertain.state().items.length, 1); assert.equal(uncertain.state().writes, 1)
  const textOnly = harness()
  assert.equal((await createManualMaterial(textOnly.pool, projectId, requestId, 'No images yet', [], textOnly.files)).item.status, 'new')
})

test('POST endpoint requires IstraArt/same origin and bounded valid fields; GET keeps its project-scoped listing', async () => {
  let calls = 0, reads = 0
  const modules: Record<string, any> = {
    'next/server': { NextResponse: { json: Response.json } }, '@/lib/db': { pool: {} }, '@/lib/crm': { resolveProjectId: async (slug: string) => slug === 'istraart' ? projectId : 2 }, '@/lib/content-factory-items': { listItems: async (_pool: unknown, id: number) => { reads++; assert.equal(id, 2); return [] } },
    '@/lib/catalog-manual-media': { CatalogMediaError }, '@/lib/content-factory-manual-intake': { createManualMaterial: async (_pool: unknown, id: number, key: string, text: string, photos: Buffer[]) => { calls++; assert.equal(id, projectId); assert.equal(key, requestId); assert.equal(text, 'Текст'); assert.equal(photos[0].toString(), 'original bytes'); return { created: calls === 1, item: { id: 'item', originKind: 'own', status: 'new' } } } },
  }
  const exports: any = {}
  const code = ts.transpileModule(readFileSync(new URL('../app/api/content-factory/items/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require','exports',code)((key: string) => { assert.ok(key in modules, key); return modules[key] }, exports)
  const req = (project = 'istraart', origin = 'https://admin.olnoo.com', extra = false) => {
    const form = new FormData(); form.set('requestId', requestId); form.set('text', 'Текст'); form.append('file', new File(['original bytes'],'one.png')); if (extra) form.set('status','published')
    return new Request(`http://localhost:3140/api/content-factory/items?project=${project}`, { method: 'POST', headers: { Origin: origin }, body: form })
  }
  assert.equal((await exports.POST(req('other'))).status, 404)
  assert.equal((await exports.POST(req('istraart','https://evil.test'))).status, 403)
  assert.equal((await exports.POST(req('istraart','https://admin.olnoo.com',true))).status, 422); assert.equal(calls, 0)
  assert.equal((await exports.POST(new Request('http://localhost:3140/api/content-factory/items?project=istraart', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=broken' }, body: 'not multipart' }))).status, 422)
  assert.equal((await exports.POST(new Request('http://localhost:3140/api/content-factory/items?project=istraart', { method: 'POST', body: '{}' }))).status, 415)
  assert.equal(calls, 0)
  assert.equal((await exports.POST(req())).status, 201); assert.equal((await exports.POST(req())).status, 200)
  assert.equal((await exports.GET(new Request('https://admin.test/api/content-factory/items?project=other'))).status, 200); assert.equal(reads, 1)
})


test('a manual material feeds the existing raw/finished card create and manual-publish handlers without AI or Social', async () => {
  for (const kind of ['raw','finished'] as const) {
    const h = harness(), png = await image()
    const material = (await createManualMaterial(h.pool, projectId, requestId, 'Ручная коряга', [png], h.files)).item
    let card: any = null, reads = 0
    const query = async (sql: string, args: any[] = []) => {
      if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return { rows: [] }
      if (sql.includes('FROM content_factory_items WHERE')) return { rows: args[0] === material.id && args[1] === projectId ? [{ id: material.id, original_image_files: material.originalImageFiles }] : [] }
      if (sql.includes('INSERT INTO catalog_cards')) {
        assert.equal(args[2], material.id)
        card = { id: args[0], project_id: args[1], content_item_id: args[2], item_id: args[2], slug: args[3], title: args[4], description: args[5], length_cm: args[6], diameter_cm: args[7], offers: JSON.parse(args[8]), card_kind: args[9], parent_card_id: args[10], manual_photo_selection: {}, manual_media: [], origin_kind: 'own', original_image_files: material.originalImageFiles, original_image_urls: material.originalImageUrls.join(','), original_image_error: '', published_at: null, version: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T00:00:00Z' }
        return { rows: [card] }
      }
      if (sql.includes('UPDATE catalog_cards')) { card.published_at = '2026-11-05'; return { rows: [card] } }
      if (sql.includes('SELECT c.*')) return { rows: card ? [card] : [] }
      throw new Error('Unexpected catalog SQL')
    }
    const modules: Record<string, any> = {
      'node:crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000002' }, 'next/server': { NextResponse: { json: Response.json } }, '@/lib/catalog-schema': schema,
      '@/lib/db': { pool: { query, connect: async () => ({ query, release() {} }) } }, '@/lib/crm': { resolveProjectId: async () => projectId }, '@/lib/catalog-card': cardData, '@/lib/catalog-manual-photo-data': photoData, '@/lib/catalog-export': { catalogInputFromRow },
      '@/lib/catalog-manual-media': { readCatalogCardPhoto: async (p: number, _c: string, item: string, files: string[], _media: unknown, _selection: unknown, index: number) => { reads++; return h.files.read(p, item, files[index]) } },
    }
    const route = (file: string) => {
      const out: any = {}, code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
      new Function('require','exports',code)((name: string) => { assert.ok(name in modules, name); return modules[name] },out)
      return out
    }
    const create = route('../app/api/catalog/cards/route.ts'), publish = route('../app/api/catalog/cards/[id]/route.ts')
    const input = { ...cardData.suggestCatalogCard({ id: material.id, originalText: material.originalText }), offers: { [kind]: { title: 'Товар владельца', description: 'Подтверждённое описание', priceRub: 1500, available: true, imageIndexes: [0] } } }
    const response = await create.POST(new Request('https://admin.test/api/catalog/cards?project=istraart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentItemId: material.id, cardKind: kind, card: input }) }))
    assert.equal(response.status, 201); assert.equal(card.published_at, null)
    const published = await publish.PATCH(new Request('https://admin.test/api/catalog/cards/card?project=istraart', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'publish' }) }), { params: Promise.resolve({ id: card.id }) })
    assert.equal(published.status, 200); assert.equal(reads, 1)
    assert.equal(catalogPublicProjection(card)?.offers[kind].priceRub, 1500)
    assert.equal(material.status, 'new'); assert.equal(material.generatedText, ''); assert.equal(material.socialPostId, null)
  }
})
