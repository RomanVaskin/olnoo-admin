import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as validation from './catalog-card.ts'
import { catalogInputFromRow, catalogPublicProjection } from './catalog-export.ts'

// Execute the real handlers with an isolated DB/file boundary; no production writes.
function harness() {
  let saved: Record<string, any> | null = null
  let readable = true
  const query = async (sql: string, values: any[]) => {
    if (sql.includes('INSERT INTO catalog_cards')) {
      saved = { id: values[0], project_id: values[1], content_item_id: values[2], slug: values[3], title: values[4], description: values[5], length_cm: values[6], diameter_cm: values[7], offers: JSON.parse(values[8]), published_at: null, version: '2026-11-04', origin_kind: 'own', original_image_files: ['a.jpg'], original_image_urls: 'file:a', original_image_error: '' }
    } else if (sql.includes('FROM content_factory_items')) {
      return { rows: values[0] === 'owner-item' && values[1] === 1 ? [{ id: 'owner-item', original_image_files: ['a.jpg'] }] : [] }
    } else if (sql.includes('UPDATE catalog_cards')) {
      assert.ok(saved)
      if (sql.includes('SET slug')) Object.assign(saved, { slug: values[0], title: values[1], description: values[2], length_cm: values[3], diameter_cm: values[4], offers: JSON.parse(values[5]) })
      else saved.published_at = sql.includes('= NULL') ? null : '2026-11-04'
    }
    const requestedProject = sql.includes('SELECT id, content_item_id') ? values[0] : sql.includes('SELECT c.*') ? values[1] : saved?.project_id
    return { rows: saved && saved.project_id === requestedProject ? [structuredClone(saved)] : [] }
  }
  function load(file: string) {
    const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exports: Record<string, any> = {}
    const modules: Record<string, unknown> = {
      'node:crypto': { randomUUID: () => 'card-id' },
      'next/server': { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
      '@/lib/db': { pool: { query } },
      '@/lib/crm': { resolveProjectId: async (slug: string) => slug === 'istraart' ? 1 : 2 },
      '@/lib/catalog-card': validation,
      '@/lib/catalog-export': { catalogInputFromRow },
      '@/lib/content-factory-original-images': { readOriginalImage: async () => readable ? Buffer.from('photo') : null },
    }
    new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in modules, name); return modules[name] }, exports)
    return exports
  }
  return { create: load('../app/api/catalog/cards/route.ts'), update: load('../app/api/catalog/cards/[id]/route.ts'), stored: () => saved!, missingPhoto: () => { readable = false } }
}
const req = (body?: unknown, project = 'istraart') => new Request(`https://admin.test/api/catalog/cards?project=${project}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
const params = { params: Promise.resolve({ id: 'card-id' }) }

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
    assert.equal(h.stored().id, 'card-id')
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
