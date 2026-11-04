import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as validation from './catalog-card.ts'
import * as manualData from './catalog-manual-photo-data.ts'
import { catalogInputFromRow, catalogPublicProjection } from './catalog-export.ts'

// Execute the real handlers with an isolated DB/file boundary; no production writes.
function harness() {
  let saved: Record<string, any>[] = []
  let snapshot: Record<string, any>[] = []
  let nextId = 0
  let readable = true
  let failKind = ''
  const query = async (sql: string, values: any[] = []) => {
    if (sql === 'BEGIN') { snapshot = structuredClone(saved); return { rows: [] } }
    if (sql === 'ROLLBACK') { saved = snapshot; return { rows: [] } }
    if (sql === 'COMMIT') return { rows: [] }
    if (sql.includes('INSERT INTO catalog_cards')) {
      if (values[9] === failKind) throw Object.assign(new Error('fixture insert failure'), { code: '23503' })
      if (saved.some((r) => r.project_id === values[1] && r.slug === values[3])) throw Object.assign(new Error('duplicate'), { code: '23505' })
      const row = { id: values[0], project_id: values[1], content_item_id: values[2], slug: values[3], title: values[4], description: values[5], length_cm: values[6], diameter_cm: values[7], offers: JSON.parse(values[8]), card_kind: values[9], parent_card_id: values[10], manual_media: [], manual_photo_selection: JSON.parse(values[11]), published_at: null, version: '2026-11-04', origin_kind: 'own', original_image_files: ['a.jpg', 'b.jpg'], original_image_urls: 'file:a,file:b', original_image_error: '' }
      saved.push(row)
      return { rows: [structuredClone(row)] }
    }
    if (sql.includes('FROM content_factory_items')) {
      return { rows: ['owner-item', 'second-item'].includes(values[0]) && values[1] === 1 ? [{ id: values[0], original_image_files: ['a.jpg', 'b.jpg'] }] : [] }
    }
    if (sql.includes("card_kind = 'finished' FOR KEY SHARE")) return { rows: saved.filter((r) => r.id === values[0] && r.project_id === values[1] && r.content_item_id === values[2] && r.card_kind === 'finished') }
    if (sql.includes('UPDATE catalog_cards')) {
      const edit = sql.includes('SET slug')
      const row = saved.find((r) => r.id === values[edit ? 6 : 0] && r.project_id === values[edit ? 7 : 1])
      if (!row) return { rows: [] }
      if (edit) Object.assign(row, { slug: values[0], title: values[1], description: values[2], length_cm: values[3], diameter_cm: values[4], offers: JSON.parse(values[5]), manual_photo_selection: JSON.parse(values[9]) })
      else row.published_at = sql.includes('= NULL') ? null : '2026-11-04'
      return { rows: [structuredClone(row)] }
    }
    return { rows: structuredClone(saved.filter((r) => sql.includes('SELECT c.*') ? r.id === values[0] && r.project_id === values[1] : r.project_id === values[0])) }
  }
  function load(file: string) {
    const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exports: Record<string, any> = {}
    const modules: Record<string, unknown> = {
      'node:crypto': { randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` },
      'next/server': { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
      '@/lib/db': { pool: { query, connect: async () => ({ query, release() {} }) } },
      '@/lib/crm': { resolveProjectId: async (slug: string) => slug === 'istraart' ? 1 : 2 },
      '@/lib/catalog-card': validation,
      '@/lib/catalog-manual-photo-data': manualData,
      '@/lib/catalog-manual-media': { readCatalogCardPhoto: async () => readable ? Buffer.from('photo') : null },
      '@/lib/catalog-export': { catalogInputFromRow },
      '@/lib/content-factory-original-images': { readOriginalImage: async () => readable ? Buffer.from('photo') : null },
    }
    new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in modules, name); return modules[name] }, exports)
    return exports
  }
  return { create: load('../app/api/catalog/cards/route.ts'), update: load('../app/api/catalog/cards/[id]/route.ts'), stored: (id = firstId) => saved.find((r) => r.id === id)!, all: () => saved, failInsert: (kind: string) => { failKind = kind }, missingPhoto: () => { readable = false } }
}
const req = (body?: unknown, project = 'istraart') => new Request(`https://admin.test/api/catalog/cards?project=${project}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
const firstId = '00000000-0000-4000-8000-000000000001'
const forCard = (id: string) => ({ params: Promise.resolve({ id }) })
const params = forCard(firstId)

for (const [kind, title] of [['raw', 'Берёзовая заготовка'], ['finished', 'Готовый светильник']] as const) {
  test(`${kind}: draft, save/reload, explicit publish, re-edit and unpublish use the same card`, async () => {
    const h = harness()
    const card = validation.suggestCatalogCard({ id: 'owner-item', originalText: title })
    assert.equal((await h.create.POST(req({ contentItemId: 'owner-item', card }))).status, 201)
    assert.equal(catalogPublicProjection(h.stored()), null)
    assert.equal((await h.update.PATCH(req({ action: 'publish' }), params)).status, 422)
    const offer = { title, description: 'Описание, введённое владельцем', priceRub: 1500, available: true, imageIndexes: [0] }
    const filled = { ...card, offers: { [kind]: offer } }
    assert.equal((await h.update.PATCH(req({ card: filled }), params)).status, 200)
    const rows = await (await h.create.GET(req())).json()
    assert.equal(rows[0].title, title)
    assert.deepEqual(rows[0].offers, filled.offers)
    assert.equal(catalogPublicProjection(h.stored()), null)
    assert.equal((await h.update.PATCH(req({ action: 'publish' }), params)).status, 200)
    assert.equal(catalogPublicProjection(h.stored())?.offers[kind]?.priceRub, 1500)
    assert.equal((await h.update.PATCH(req({ card: { ...filled, offers: { [kind]: { ...offer, priceRub: 1700 } } } }), params)).status, 200)
    assert.equal(h.stored().id, firstId)
    assert.equal(catalogPublicProjection(h.stored())?.offers[kind]?.priceRub, 1700)
    assert.equal((await h.update.PATCH(req({ action: 'unpublish' }), params)).status, 200)
    assert.equal(catalogPublicProjection(h.stored()), null)
  })
}

test('API returns field errors, refuses foreign materials and blocks unreadable photos', async () => {
  const h = harness()
  const card = validation.suggestCatalogCard({ id: 'owner-item', originalText: 'Заготовка' })
  assert.equal((await h.create.POST(req({ contentItemId: 'owner-item', card }, 'other'))).status, 404)
  const invalid = await h.create.POST(req({ contentItemId: 'owner-item', card: { ...card, title: '', slug: '' } }))
  assert.equal(invalid.status, 422)
  assert.deepEqual(Object.keys((await invalid.json()).fieldErrors).sort(), ['slug', 'title'])
  await h.create.POST(req({ contentItemId: 'owner-item', card }))
  assert.equal((await h.update.PATCH(req({ action: 'publish' }, 'other'), params)).status, 404)
  assert.deepEqual(await (await h.create.GET(req(undefined, 'other'))).json(), [])
  const raw = { title: card.title, description: '', priceRub: 1500, available: false, imageIndexes: [] }
  await h.update.PATCH(req({ card: { ...card, offers: { raw } } }), params)
  const incomplete = await h.update.PATCH(req({ action: 'publish' }), params)
  assert.equal(incomplete.status, 422)
  assert.deepEqual(Object.keys((await incomplete.json()).fieldErrors).sort(), ['offers.raw.description', 'offers.raw.imageIndexes'])
  await h.update.PATCH(req({ card: { ...card, offers: { raw: { ...raw, description: 'Подтверждено', imageIndexes: [0] } } } }), params)
  h.missingPhoto()
  const missing = await h.update.PATCH(req({ action: 'publish' }), params)
  assert.equal(missing.status, 409)
  assert.ok((await missing.json()).fieldErrors['offers.raw.imageIndexes'])
  assert.equal(h.stored().published_at, null)
})

test('one source creates several independent products without a material or guide; publication and photos stay independent', async () => {
  const h = harness()
  const offer = { title: 'Изделие', description: 'Подтверждено владельцем', priceRub: 1500, available: true, imageIndexes: [0] }
  const first = { ...validation.suggestCatalogCard({ id: 'lamp', originalText: 'Светильник' }), offers: { finished: offer } }
  const second = { ...validation.suggestCatalogCard({ id: 'sculpture', originalText: 'Скульптура' }), offers: { finished: { ...offer, priceRub: 2500, imageIndexes: [1] } } }
  const a = await (await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'finished', card: first }))).json()
  const b = await (await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'finished', card: second }))).json()
  assert.notEqual(a.id, b.id)
  assert.notEqual(a.slug, b.slug)
  assert.equal(h.all().length, 2)
  assert.ok(h.all().every((c) => c.card_kind === 'finished' && c.content_item_id === 'owner-item' && !c.published_at))
  assert.equal((await h.update.PATCH(req({ action: 'publish' }), forCard(a.id))).status, 200)
  assert.equal(catalogPublicProjection(h.stored(b.id)), null)
  const { catalogPhotoSelection } = await import('./catalog-export.ts')
  assert.equal(catalogPhotoSelection(h.stored(a.id), 1), null)
  assert.equal((await h.update.PATCH(req({ action: 'publish' }), forCard(b.id))).status, 200)
  assert.equal(catalogPublicProjection(h.stored(b.id))?.offers.finished.priceRub, 2500)
  assert.equal(catalogPhotoSelection(h.stored(b.id), 0), null)
  assert.equal((await h.update.PATCH(req({ action: 'unpublish' }), forCard(a.id))).status, 200)
  assert.ok(catalogPublicProjection(h.stored(b.id)))
  assert.equal((await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'finished', card: second }))).status, 409)
  assert.equal(h.all().length, 2, 'retrying the same slug cannot create another product')
})

test('optional material and guide are separate empty drafts with independent IDs, slugs and a specific parent', async () => {
  const h = harness()
  const card = validation.suggestCatalogCard({ id: 'lamp', originalText: 'Светильник' })
  const response = await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'finished', card, createRaw: true, createGuide: true }))
  assert.equal(response.status, 201)
  const created = await response.json()
  assert.equal(created.createdCards.length, 3)
  const records = h.all()
  assert.equal(new Set(records.map((c) => c.id)).size, 3)
  assert.equal(new Set(records.map((c) => c.slug)).size, 3)
  assert.equal(records.find((c) => c.card_kind === 'guide')?.parent_card_id, created.id)
  assert.equal(records.find((c) => c.card_kind === 'raw')?.parent_card_id, null)
  for (const row of records) {
    assert.equal(row.content_item_id, 'owner-item')
    assert.deepEqual(row.offers, {})
    assert.equal(catalogPublicProjection(row), null)
  }
  const guideRow = records.find((c) => c.card_kind === 'guide')!
  const guideInput = { ...catalogInputFromRow(guideRow), offers: { guide: { title: guideRow.title, description: 'Гайд по подтверждённому изделию', priceRub: 500, available: true, imageIndexes: [1] } } }
  assert.equal((await h.update.PATCH(req({ card: guideInput }), forCard(guideRow.id))).status, 200)
  assert.equal((await h.update.PATCH(req({ action: 'publish' }), forCard(guideRow.id))).status, 200)
  assert.ok(catalogPublicProjection(h.stored(guideRow.id)))
  assert.equal(h.stored(created.id).published_at, null, 'a guide can publish without approving or publishing its parent')
  assert.equal(h.stored(records.find((c) => c.card_kind === 'raw')!.id).published_at, null)
  const parent = created.id
  const guide = validation.suggestCatalogCard({ id: 'guide-2', originalText: 'Другой гайд' })
  assert.equal((await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'guide', parentCardId: parent, card: guide }))).status, 201)
  assert.equal((await h.create.POST(req({ contentItemId: 'second-item', cardKind: 'guide', parentCardId: parent, card: guide }))).status, 404)
  assert.equal((await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'guide', parentCardId: parent, card: guide }, 'other'))).status, 404)
  assert.equal((await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'guide', parentCardId: records.find((c) => c.card_kind === 'raw')!.id, card: guide }))).status, 404)
  assert.equal((await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'guide', card: guide }))).status, 400)
})

test('a typed card cannot include another offer kind or change its immutable links through PATCH', async () => {
  const h = harness()
  const card = validation.suggestCatalogCard({ id: 'lamp', originalText: 'Светильник' })
  const created = await (await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'finished', card }))).json()
  const raw = { title: 'Материал', description: 'Описание', priceRub: 1500, available: true, imageIndexes: [0] }
  const bad = { ...card, offers: { raw } }
  assert.equal((await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'finished', card: bad }))).status, 422)
  assert.equal((await h.update.PATCH(req({ card: bad }), forCard(created.id))).status, 422)
  assert.equal((await h.update.PATCH(req({ card, cardKind: 'raw' }), forCard(created.id))).status, 400)
  assert.equal((await h.update.PATCH(req({ card, parentCardId: created.id }), forCard(created.id))).status, 400)
  assert.equal((await h.update.PATCH(req({ card }, 'other'), forCard(created.id))).status, 404)
})

test('failure creating a related guide rolls back the whole draft bundle', async () => {
  const h = harness()
  h.failInsert('guide')
  const card = validation.suggestCatalogCard({ id: 'lamp', originalText: 'Светильник' })
  const response = await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'finished', card, createRaw: true, createGuide: true }))
  assert.equal(response.status, 409)
  assert.deepEqual(h.all(), [])
})

test('a text-only owner material can publish a manually uploaded photo without exposing another card file', async () => {
  const h = harness()
  const empty = validation.suggestCatalogCard({ id: 'owner-item', originalText: 'Изделие' })
  await h.create.POST(req({ contentItemId: 'owner-item', cardKind: 'finished', card: empty }))
  const row = h.stored(), assetId = '00000000-0000-4000-8000-000000000099'
  // Simulate the card metadata appended by the separately tested upload handler.
  row.original_image_files = []; row.original_image_urls = ''
  row.manual_media = [{ id: assetId, filename: `${assetId}.png`, slot: 0, kind: 'ai', origin: 'upload', mimeType: 'image/png', createdAt: '2026-11-04T00:00:00Z' }]
  const card = { ...empty, offers: { finished: { title: 'Изделие', description: 'Проверено владельцем', priceRub: 1500, available: true, imageIndexes: [0] } }, manualPhotoSelection: { 0: assetId } }
  assert.equal((await h.update.PATCH(req({ card }), params)).status, 200)
  assert.deepEqual(row.manual_photo_selection, { 0: assetId })
  assert.equal((await h.update.PATCH(req({ action: 'publish' }), params)).status, 200)
  assert.ok(catalogPublicProjection(row))
  const other = { ...card, manualPhotoSelection: { 0: '00000000-0000-4000-8000-000000000098' } }
  assert.equal((await h.update.PATCH(req({ card: other }), params)).status, 422)
  assert.deepEqual(row.manual_photo_selection, { 0: assetId })
  assert.equal((await h.update.PATCH(req({ action: 'unpublish' }), params)).status, 200)
  assert.equal(catalogPublicProjection(row), null)
})
