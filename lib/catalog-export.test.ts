import * as catalogSchema from './catalog-schema.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as catalogExport from './catalog-export.ts'
import { catalogSiteProject, catalogPublicCards, catalogPublicProjection, catalogPhotoSelection, publishedCatalogRows } from './catalog-export.ts'
import { publishableCatalogCard } from './catalog-card.ts'
const token = 'a'.repeat(40)
const row = { id: 'e62bad4e-0514-442c-a4df-3d2cf83f8844', slug: 'wood-1', title: 'Находка', description: 'Истра', length_cm: '30.00', diameter_cm: null,
  offers: { raw: { title: 'Материал', description: 'Подтверждённая заготовка', priceRub: 1500, available: true, imageIndexes: [0] }, guide: { title: 'Гайд', description: 'Запрос покупки', priceRub: 500, available: false, imageIndexes: [2] } },
  published_at: '2026-11-04', updated_at: '2026-11-04', origin_kind: 'own', original_image_urls: 'file:a,file:b,file:c', original_image_error: '', original_image_files: ['a.jpg', 'private.jpg', 'guide.jpg'], item_id: 'internal-item', project_id: 7, original_text: 'private source', pdf_path: 'private.pdf' }
test('site token is required, scoped to one project, and malformed/reused mappings fail closed', () => {
  const map = JSON.stringify({ istraart: token, other: 'b'.repeat(40) })
  assert.equal(catalogSiteProject(token, map), 'istraart')
  assert.equal(catalogSiteProject(null, map), null)
  assert.equal(catalogSiteProject('wrong', map), null)
  assert.equal(catalogSiteProject(token, JSON.stringify({ istraart: token, other: token })), null)
  assert.equal(catalogSiteProject(token, '{}'), null)
  assert.equal(catalogSiteProject(token, 'not json'), null)
})
test('public projection excludes drafts, foreign source types, private files and source text', () => {
  const card = catalogPublicProjection(row)!
  assert.equal(card.lengthCm, 30)
  assert.deepEqual(Object.keys(card.offers), ['raw', 'guide'])
  assert.equal(card.offers.guide?.available, false)
  for (const privateValue of ['private source', 'private.jpg', 'private.pdf', 'internal-item', 'project_id']) assert.equal(JSON.stringify(card).includes(privateValue), false)
  assert.equal(catalogPublicProjection({ ...row, published_at: null }), null)
  assert.equal(catalogPublicProjection({ ...row, origin_kind: 'source' }), null)
  assert.equal(catalogPublicProjection({ ...row, original_image_error: 'incomplete' }), null)
})
test('only photos actually referenced by published offers can be exported', () => {
  assert.deepEqual(catalogPhotoSelection(row, 0), { projectId: 7, itemId: 'internal-item', filename: 'a.jpg' })
  assert.equal(catalogPhotoSelection(row, 1), null)
  assert.equal(catalogPhotoSelection({ ...row, published_at: null }, 0), null)
  assert.equal(catalogPhotoSelection(row, -1), null)
})
test('publication refuses empty/partial offers and photo references outside this material', () => {
  const input = { slug: row.slug, title: row.title, description: '', lengthCm: null, diameterCm: null, offers: row.offers }
  assert.equal(publishableCatalogCard(input, 3), true)
  assert.equal(publishableCatalogCard({ ...input, offers: {} }, 3), false)
  assert.equal(publishableCatalogCard({ ...input, offers: { raw: { ...row.offers.raw, description: '' } } }, 3), false)
  assert.equal(publishableCatalogCard({ ...input, offers: { raw: { ...row.offers.raw, imageIndexes: [] } } }, 3), false)
  assert.equal(publishableCatalogCard(input, 1), false)
})
test('published query is project-bound and joins the same-project owner item', async () => {
  const pool = { query: async (sql: string, values: unknown[]) => {
    assert.match(sql, /p.slug = \$1/)
    assert.match(sql, /c.published_at IS NOT NULL/)
    assert.match(sql, /c.parent_card_id/)
    assert.match(sql, /i.project_id = c.project_id/)
    assert.match(sql, /i.origin_kind = 'own'/)
    assert.deepEqual(values, ['istraart', null])
    return { rows: [row] }
  } } as unknown as Pool
  assert.equal((await publishedCatalogRows(pool, 'istraart')).length, 1)
})
test('price/photo edits keep the same public card identity without manufacturing offers', () => {
  const before = catalogPublicProjection(row)!
  const after = catalogPublicProjection({ ...row, updated_at: '2026-11-05', offers: { raw: { ...row.offers.raw, priceRub: 1700, imageIndexes: [2] } } })!
  assert.equal(after.id, before.id)
  assert.equal(after.offers.raw.priceRub, 1700)
  assert.deepEqual(after.offers.raw.imageIndexes, [2])
  assert.equal(after.offers.guide, undefined)
})

test('independent products retain the existing DTO; drafts and unrelated photos do not leak through shared sources', () => {
  const a = { ...row, card_kind: 'finished', offers: { finished: { ...row.offers.raw, imageIndexes: [0] } } }
  const b = { ...a, id: 'e62bad4e-0514-442c-a4df-3d2cf83f8845', slug: 'sculpture', offers: { finished: { ...row.offers.raw, imageIndexes: [2] } } }
  assert.notEqual(catalogPublicProjection(a)?.id, catalogPublicProjection(b)?.id)
  assert.deepEqual(Object.keys(catalogPublicProjection(a)!.offers), ['finished'])
  assert.equal(catalogPhotoSelection(a, 2), null)
  assert.equal(catalogPhotoSelection(b, 0), null)
  assert.equal(catalogPhotoSelection({ ...b, published_at: null }, 2), null)
  assert.equal(catalogPublicProjection({ ...a, offers: row.offers }), null)
  // Relations stay internal: no link or metadata about a draft parent is exported.
  const guide = { ...row, card_kind: 'guide', parent_card_id: a.id, offers: { guide: row.offers.guide } }
  assert.equal(JSON.stringify(catalogPublicProjection(guide)).includes('parent_card_id'), false)
  assert.equal(JSON.stringify(catalogPublicProjection(guide)).includes('content_item_id'), false)
})

test('related cards link finished/raw/guide in both directions without linking sibling guides', () => {
  const own = (n: number, kind: 'raw' | 'finished' | 'guide', parent: string | null = null) => ({
    ...row, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, slug: `card-${n}`, title: `Карточка ${n}`,
    card_kind: kind, parent_card_id: parent, offers: { [kind]: row.offers.raw },
  })
  const raw = own(1, 'raw'), lamp = own(2, 'finished'), sculpture = own(3, 'finished')
  const lampGuide = own(4, 'guide', lamp.id), sculptureGuide = own(5, 'guide', sculpture.id)
  const cards = catalogPublicCards([raw, lamp, sculpture, lampGuide, sculptureGuide])
  const related = (id: string) => cards.find((c) => c.id === id)!.relatedCards!
  const summary = (r: typeof raw) => ({ id: r.id, slug: r.slug, title: r.title, type: r.card_kind })
  assert.deepEqual(related(raw.id), [summary(lamp), summary(sculpture)])
  assert.deepEqual(related(lamp.id), [summary(raw), summary(lampGuide)])
  assert.deepEqual(related(sculpture.id), [summary(raw), summary(sculptureGuide)])
  assert.deepEqual(related(lampGuide.id), [summary(raw), summary(lamp)])
  assert.deepEqual(related(sculptureGuide.id), [summary(raw), summary(sculpture)])
  assert.deepEqual(Object.keys(related(lamp.id)[0]).sort(), ['id', 'slug', 'title', 'type'])
  // All previous top-level DTO fields and offers retain their values.
  const { relatedCards: _links, ...unchanged } = cards.find((c) => c.id === lamp.id)!
  assert.deepEqual(unchanged, catalogPublicProjection(lamp))
  const unpublished = catalogPublicCards([raw, lamp, { ...lampGuide, published_at: null }])
  assert.equal(unpublished.some((c) => c.id === lampGuide.id), false)
  assert.deepEqual(unpublished.find((c) => c.id === lamp.id)!.relatedCards, [summary(raw)])
})

test('relations exclude drafts, invalid published cards, foreign projects and other source items', () => {
  const product = { ...row, card_kind: 'finished', offers: { finished: row.offers.raw } }
  const candidates = [
    { ...row, id: '00000000-0000-4000-8000-000000000001', slug: 'draft-raw', title: 'PRIVATE DRAFT', card_kind: 'raw', offers: { raw: row.offers.raw }, published_at: null },
    { ...row, id: '00000000-0000-4000-8000-000000000002', slug: 'foreign-raw', title: 'OTHER PROJECT', card_kind: 'raw', offers: { raw: row.offers.raw }, project_id: 8 },
    { ...row, id: '00000000-0000-4000-8000-000000000003', slug: 'other-source', title: 'OTHER SOURCE', card_kind: 'raw', offers: { raw: row.offers.raw }, item_id: 'different-private-source' },
    { ...row, id: '00000000-0000-4000-8000-000000000004', slug: 'bad-raw', title: 'INCOMPLETE', card_kind: 'raw', offers: { raw: { ...row.offers.raw, description: '' } } },
    { ...row, id: '00000000-0000-4000-8000-000000000005', slug: 'bad-media', title: 'MISSING MEDIA', card_kind: 'raw', offers: { raw: row.offers.raw }, original_image_error: 'failed' },
    { ...row, id: '00000000-0000-4000-8000-000000000006', slug: 'foreign-guide', title: 'FOREIGN GUIDE', card_kind: 'guide', offers: { guide: row.offers.guide }, parent_card_id: product.id, project_id: 8 },
    { ...row, id: '00000000-0000-4000-8000-000000000007', slug: 'unrelated-guide', title: 'UNRELATED GUIDE', card_kind: 'guide', offers: { guide: row.offers.guide }, parent_card_id: '00000000-0000-4000-8000-000000000099' },
  ]
  const cards = catalogPublicCards([product, ...candidates])
  const exportedProduct = cards.find((c) => c.id === product.id)!
  assert.equal(exportedProduct.relatedCards, undefined)
  assert.deepEqual(exportedProduct, catalogPublicProjection(product))
  assert.equal(cards.some((c) => c.slug === 'draft-raw' || c.slug === 'bad-raw' || c.slug === 'bad-media'), false)
  for (const secret of ['PRIVATE DRAFT', 'OTHER PROJECT', 'OTHER SOURCE', 'INCOMPLETE', 'MISSING MEDIA', 'FOREIGN GUIDE', 'UNRELATED GUIDE', 'internal-item', 'project_id', 'parent_card_id']) {
    assert.equal(JSON.stringify(exportedProduct).includes(secret), false)
  }
  // A published guide cannot expose the UUID or title of its unpublished parent.
  const guide = { ...row, id: '00000000-0000-4000-8000-000000000008', card_kind: 'guide', parent_card_id: product.id, offers: { guide: row.offers.guide } }
  const [exportedGuide] = catalogPublicCards([guide, { ...product, published_at: null }])
  assert.equal(exportedGuide.relatedCards, undefined)
  assert.equal(JSON.stringify(exportedGuide).includes(product.id), false)
  // Legacy cards keep their previous shape, without guessing typed relations.
  assert.deepEqual(catalogPublicCards([row])[0], catalogPublicProjection(row))
})

test('the actual export handler includes relatedCards and scopes the query to the authenticated project', async () => {
  const previous = process.env.CATALOG_SITE_TOKENS
  process.env.CATALOG_SITE_TOKENS = JSON.stringify({ istraart: token, other: 'b'.repeat(40) })
  try {
    const raw = { ...row, card_kind: 'raw', offers: { raw: row.offers.raw } }
    const product = { ...row, id: '00000000-0000-4000-8000-000000000001', card_kind: 'finished', offers: { finished: row.offers.raw } }
    const draft = { ...raw, id: '00000000-0000-4000-8000-000000000002', title: 'PRIVATE DRAFT', published_at: null }
    const requests: unknown[][] = []
    const modules: Record<string, unknown> = {
      '@/lib/catalog-schema': catalogSchema,
      'next/server': { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
      '@/lib/catalog-export': catalogExport,
      '@/lib/db': { pool: { query: async (sql: string, values: unknown[]) => {
        assert.match(sql, /p.slug = \$1/)
        assert.match(sql, /i.project_id = c.project_id/)
        assert.match(sql, /c.published_at IS NOT NULL/)
        requests.push(values)
        return { rows: values[0] === 'istraart' ? [raw, product, draft] : [] }
      } } },
    }
    const compiled = ts.transpileModule(readFileSync(new URL('../app/api/catalog/export/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exports: Record<string, any> = {}
    new Function('require', 'exports', compiled)((name: string) => { assert.ok(name in modules); return modules[name] }, exports)
    const request = (key?: string) => new Request('https://admin.test/api/catalog/export?project=other', { headers: key ? { 'X-Olnoo-Catalog-Token': key } : {} })
    assert.equal((await exports.GET(request())).status, 403)
    assert.equal(requests.length, 0)
    const response = await exports.GET(request(token))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const data = await response.json()
    assert.equal(data.project, 'istraart')
    assert.equal(data.cards.length, 2)
    assert.deepEqual(data.cards.find((c: { id: string }) => c.id === product.id).relatedCards, [{ id: raw.id, slug: raw.slug, title: raw.title, type: 'raw' }])
    for (const privateValue of ['PRIVATE DRAFT', 'internal-item', 'parent_card_id', 'project_id', 'private.pdf']) assert.equal(JSON.stringify(data).includes(privateValue), false)
    assert.deepEqual(await (await exports.GET(request('b'.repeat(40)))).json(), { project: 'other', cards: [] })
    assert.deepEqual(requests, [['istraart', null], ['other', null]])
  } finally {
    if (previous === undefined) delete process.env.CATALOG_SITE_TOKENS
    else process.env.CATALOG_SITE_TOKENS = previous
  }
})
