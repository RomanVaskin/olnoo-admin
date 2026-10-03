import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clusterLocale, getRecommendedPages, pagesForLocale, searchPages, type PageOption } from './cluster-pages.ts'

const page = (id: number, path: string, locale: string | null = null, title: string | null = null): PageOption => ({
  id,
  url: `https://driveset.ru${path}`,
  locale,
  title,
  h1: null,
  description: null,
})

const polish = page(1, '/polirovka-avto', null, 'Полировка авто') // no prefix, locale unknown → neutral
const ruPage = page(2, '/ru/detejling', null, 'Детейлинг')
const enPage = page(3, '/en/polishing', null, 'Polishing')
const enByLocale = page(4, '/polishing-guide', 'EN', 'Polishing guide') // no prefix, but the stored locale says EN
const pages = [polish, ruPage, enPage, enByLocale]

const cluster = (primaryKeyword: string, name = primaryKeyword) => ({ name, primaryKeyword, recommendedPageId: null, recommendedPageUrl: null })

test('RU cluster finds a page without a language prefix and without a stored locale (neutral)', () => {
  const ru = clusterLocale(cluster('полировка фар'), pages)
  assert.equal(ru, 'ru')
  const ids = pagesForLocale(pages, ru).map((p) => p.id)
  assert.ok(ids.includes(1), '/polirovka-avto is offered')
  assert.ok(ids.includes(2), 'explicit RU page is offered')
  assert.deepEqual(searchPages(pagesForLocale(pages, ru), 'polirovka').map((p) => p.id), [1])
  assert.equal(getRecommendedPages(cluster('полировка авто', 'Полировка фар'), pages)[0]?.id, 1, 'and can be recommended')
})

test('RU cluster does not show explicitly EN pages (prefix or stored locale)', () => {
  const ids = pagesForLocale(pages, 'ru').map((p) => p.id)
  assert.ok(!ids.includes(3) && !ids.includes(4))
  const recommended = getRecommendedPages(cluster('полировка', 'polishing'), pages).map((p) => p.id)
  assert.ok(!recommended.includes(3) && !recommended.includes(4))
})

test('EN cluster does not show explicitly RU pages, but still sees EN and neutral ones', () => {
  const en = clusterLocale(cluster('headlight polishing'), pages)
  assert.equal(en, 'en')
  const ids = pagesForLocale(pages, en).map((p) => p.id)
  assert.ok(!ids.includes(2), 'explicit RU page is hidden')
  assert.deepEqual(ids.sort(), [1, 3, 4])
})

test('unknown cluster language keeps every page', () => {
  assert.equal(pagesForLocale(pages, null).length, pages.length)
})
