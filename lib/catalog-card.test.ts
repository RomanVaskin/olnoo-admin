import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCatalogCard, publicCatalogCard, suggestCatalogCard, catalogCardErrors, publishableCatalogCard } from './catalog-card.ts'

const card = {
  slug: 'koryaga-001', title: 'Коряга №001', description: 'Истра',
  lengthCm: 30, diameterCm: 5,
  offers: { raw: { title: 'Заготовка', description: '', priceRub: 1500, available: true, imageIndexes: [0] },
    guide: { title: 'Гайд по светильнику', description: 'PDF после оплаты', priceRub: 500, available: false, imageIndexes: [] } },
}
test('one source can expose raw and guide without inventing a finished product', () => {
  assert.equal(validateCatalogCard(card, 1), true)
  assert.deepEqual(Object.keys(publicCatalogCard(card).offers), ['raw', 'guide'])
})
test('invalid prices, photo indexes and unknown offer types are rejected', () => {
  assert.equal(validateCatalogCard({ ...card, offers: { raw: { ...card.offers.raw, priceRub: 0 } } }, 1), false)
  assert.equal(validateCatalogCard({ ...card, offers: { raw: { ...card.offers.raw, imageIndexes: [2] } } }, 1), false)
  assert.equal(validateCatalogCard({ ...card, offers: { lamp: card.offers.raw } }, 1), false)
})
test('no prices or products are manufactured from an empty card', () => {
  const empty = { ...card, offers: {} }
  assert.equal(validateCatalogCard(empty, 1), true)
  assert.deepEqual(publicCatalogCard(empty).offers, {})
})

test('new owner materials suggest editable titles/slugs without invented commercial details', () => {
  // Representative fixtures, not production Telegram materials.
  for (const originalText of ['Берёзовая заготовка\nФото из мастерской', 'Готовый светильник\nРучная работа']) {
    const suggestion = suggestCatalogCard({ id: 'abcdef01-0000-4000-8000-000000000000', originalText })
    assert.equal(suggestion.title, originalText.split('\n')[0])
    assert.match(suggestion.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*-abcdef01$/)
    assert.equal(validateCatalogCard(suggestion, 1), true)
    assert.deepEqual(suggestion.offers, {})
    assert.equal(suggestion.description, '')
    assert.equal(suggestion.lengthCm, null)
    assert.equal(suggestion.diameterCm, null)
    assert.notEqual(suggestion.slug, suggestCatalogCard({ id: 'abcdef02', originalText }).slug)
  }
  assert.equal(suggestCatalogCard({ id: '123', ownBrief: 'Описание владельца' }).title, 'Описание владельца')
  assert.equal(validateCatalogCard(suggestCatalogCard({ id: '123' }), 0), true)
})

test('field errors identify missing values and enforce the same publication rules as the server', () => {
  const invalid = { ...card, title: '', slug: 'Нельзя', lengthCm: -1, offers: { raw: { title: '', description: '', priceRub: 0, available: null, imageIndexes: [] } } }
  const errors = catalogCardErrors(invalid, 1, true)
  assert.deepEqual(Object.keys(errors).sort(), ['title', 'slug', 'lengthCm', 'offers.raw.title', 'offers.raw.description', 'offers.raw.priceRub', 'offers.raw.available', 'offers.raw.imageIndexes'].sort())
  assert.match(errors['offers.raw.priceRub'], /подтверждённую цену/)
  const ready = { ...card, offers: { raw: { ...card.offers.raw, description: 'Заготовка для творчества' } } }
  assert.equal(publishableCatalogCard(ready, 1), true)
  for (const patch of [{ description: '' }, { priceRub: 0 }, { available: null }, { imageIndexes: [] }, { imageIndexes: [1] }, { imageIndexes: [0, 0] }]) {
    const input = { ...ready, offers: { raw: { ...ready.offers.raw, ...patch } } }
    assert.equal(publishableCatalogCard(input, 1), false)
    assert.notEqual(Object.keys(catalogCardErrors(input, 1, true)).length, 0)
  }
  assert.equal(validateCatalogCard({ ...ready, offers: { raw: { ...ready.offers.raw, description: '', imageIndexes: [] } } }, 1), true)
})
