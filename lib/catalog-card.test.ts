import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCatalogCard, publicCatalogCard } from './catalog-card.ts'

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
