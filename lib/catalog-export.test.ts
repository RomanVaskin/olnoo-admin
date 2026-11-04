import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { catalogSiteProject, catalogPublicProjection, catalogPhotoSelection, publishedCatalogRows } from './catalog-export.ts'
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
