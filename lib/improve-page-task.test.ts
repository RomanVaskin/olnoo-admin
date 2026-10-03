import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildImproveTask, type TaskCluster, type TaskPage } from './seo-task-generator.ts'
import { buildImproveTaskForPage, clustersConfirmedForPage, type ImproveClusterInput } from './improve-page-task.ts'
import type { PageOption } from './cluster-pages.ts'

const project = { name: 'DriveSet', domain: 'driveset.ru' }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const page: TaskPage = {
  url: 'https://driveset.ru/polirovka-avto',
  title: 'Полировка авто',
  h1: 'Полировка',
  description: null,
  locale: null,
}
const pages: PageOption[] = [
  { id: 7, url: page.url, locale: null, title: page.title, h1: page.h1, description: null },
  { id: 8, url: 'https://driveset.ru/other', locale: null, title: null, h1: null, description: null },
]

function single(intent: string): TaskCluster {
  return {
    name: 'Полировка фар',
    primaryKeyword: 'полировка фар',
    intent,
    totalFrequency: 900,
    keywords: [
      { query: 'полировка фар', frequency: 600 },
      { query: 'полировка фар цена', frequency: 300 },
    ],
  }
}

// Golden hashes: the single-cluster prompt must stay byte-identical to the pre-change output.
test('single cluster output is unchanged (golden hashes)', () => {
  assert.equal(sha(buildImproveTask(project, single('commercial'), page, 'ru')), '40dba33db37e86ebd844fc12ccab8c8e3d85f2de6b399c27325d07da16552116')
  assert.equal(sha(buildImproveTask(project, single('informational'), page, 'ru')), '69da19c757c7bebb0985a933d6a79864024db2c1d356c8019ad623b195aaf418')
  assert.equal(sha(buildImproveTask(project, single('mixed'), page, 'ru')), '69ed58e07607c0138898c3d92485aced3b7753e6f703285b60a1d42daf7a18e1')
  assert.equal(buildImproveTask(project, [single('commercial')], page, 'ru'), buildImproveTask(project, single('commercial'), page, 'ru'))
})

function row(over: Partial<ImproveClusterInput> & { id: number; name: string }): ImproveClusterInput {
  return {
    primaryKeyword: over.name.toLowerCase(),
    intent: 'commercial',
    totalFrequency: 100,
    keywords: [{ query: over.name.toLowerCase(), frequency: 100 }],
    recommendedPageId: null,
    recommendedPageUrl: null,
    reviewStatus: 'confirmed',
    confirmedPageId: 7,
    confirmedPageUrl: page.url,
    ...over,
  }
}

const body = row({ id: 1, name: 'Полировка кузова', totalFrequency: 2000, keywords: [{ query: 'полировка кузова', frequency: 1500 }, { query: 'полировка кузова цена', frequency: 500 }] })
const lights = row({ id: 2, name: 'Полировка фар', totalFrequency: 900, keywords: [{ query: 'полировка фар', frequency: 900 }] })

test('DoD: both clusters of /polirovka-avto in one prompt, regardless of order', () => {
  const a = buildImproveTaskForPage(project, [body, lights], pages, 7)!
  const b = buildImproveTaskForPage(project, [lights, body], pages, 7)!
  assert.equal(a, b)
  for (const s of ['Name: Полировка кузова', 'Name: Полировка фар', 'Primary keyword: полировка кузова', 'Primary keyword: полировка фар',
    'Intent: commercial', 'Total frequency: 2000', 'Total frequency: 900', 'полировка кузова цена — 500', 'SEO clusters страницы (2):']) {
    assert.ok(a.includes(s), s)
  }
  assert.ok(a.indexOf('Полировка кузова') < a.indexOf('Name: Полировка фар'))
  assert.equal(a.split(page.url).length - 1, 2) // «Целевая страница» + «Current page: URL» — a single page
  assert.ok(a.includes('НЕ создавать новую страницу.'))
  assert.ok(a.includes('ВСЕ'))
  for (const s of ['SEO RULE:', 'CTA / CONVERSION RULE:', 'INTERNAL LINKS RULE:', 'COVERAGE CHECK:', 'CONTENT QUALITY GATE:']) assert.ok(a.includes(s), s)
})

test('only confirmed clusters of the same page are included', () => {
  const pending = row({ id: 3, name: 'Полировка салона', reviewStatus: 'pending' })
  const otherPage = row({ id: 4, name: 'Керамика', confirmedPageId: 8 })
  const ignored = row({ id: 5, name: 'Шумка', reviewStatus: 'ignored', confirmedPageId: 7 })
  const group = clustersConfirmedForPage([lights, pending, otherPage, ignored, body], 7)
  assert.deepEqual(group.map((c) => c.id), [1, 2])
  const text = buildImproveTaskForPage(project, [lights, pending, otherPage, ignored, body], pages, 7)!
  assert.ok(!text.includes('Полировка салона') && !text.includes('Керамика') && !text.includes('Шумка'))
})

test('one confirmed cluster keeps the classic prompt; none → null', () => {
  const text = buildImproveTaskForPage(project, [lights, row({ id: 9, name: 'x', confirmedPageId: 8 })], pages, 7)!
  assert.ok(text.includes('SEO cluster:') && !text.includes('SEO clusters страницы'))
  assert.equal(buildImproveTaskForPage(project, [lights], pages, 99), null)
})

test('mixed intents across clusters include both CTA rules', () => {
  const info = row({ id: 6, name: 'Как полировать фары', intent: 'informational', totalFrequency: 50 })
  const text = buildImproveTaskForPage(project, [body, info], pages, 7)!
  assert.ok(text.includes('Для commercial intent:') && text.includes('Для informational intent:'))
})
