import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildCreateTask, buildImproveTask, type TaskCluster, type TaskPage } from './seo-task-generator.ts'
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

// Golden hashes of the Create prompt. Deliberately updated by the step A patch (shared guardrail, project-agnostic CTA,
// existing URL structure instead of /ru/ /en/, AI/GEO quality gate) after reviewing the prompt diff; any other change must
// update them consciously.
test('Create prompt golden hashes', () => {
  assert.equal(sha(buildCreateTask(project, single('commercial'), 'ru')), '9fcf4ecb27851f83928ba8f2d358f254302968be701ed395606002a80656fca5')
  assert.equal(sha(buildCreateTask(project, single('informational'), 'ru')), 'c64e53029865c4a40440d835a7d8ac691a3760d928fe190e0a035a7876f0625a')
  assert.equal(sha(buildCreateTask(project, single('mixed'), 'ru')), '366483f58ce1bfcd2bc14e219d5ab791d0cbb5cc71ba978eb6986ef57a36a1b9')
})

test('single-cluster call: array and plain cluster are equivalent', () => {
  assert.equal(buildImproveTask(project, [single('commercial')], page, 'ru'), buildImproveTask(project, single('commercial'), page, 'ru'))
})

test('Improve prompt carries the business-facts guardrail (single and multi)', () => {
  const multi = buildImproveTaskForPage(project, [row({ id: 1, name: 'A' }), row({ id: 2, name: 'B' })], pages, 7)!
  for (const text of [buildImproveTask(project, single('commercial'), page, 'ru'), multi]) {
    assert.ok(text.includes('BUSINESS FACTS / SEMANTIC SAFETY RULE:'))
    assert.ok(text.includes('НЕ являются источником фактов о бизнесе'))
    assert.ok(text.includes('обслуживание конкретного города/района'))
    assert.ok(text.includes('новую услугу или новый тип работ'))
    assert.ok(text.includes('НЕ добавлять утверждение на страницу.'))
    assert.ok(text.includes('НЕ пытаться механически покрыть keyword.'))
    assert.ok(text.includes('Intentionally not covered:\n- <topic/query> — not confirmed by project facts'))
    assert.ok(text.includes('Это НЕ FAIL'))
    assert.ok(text.includes('CANDIDATE SEPARATE PAGES\n- <тема>'))
    assert.ok(text.includes('recommended action: review for separate page'))
    assert.ok(text.includes('НЕ создавай для неё новую страницу'))
    assert.ok(text.includes('не каждый long-tail'))
    // the guardrail precedes the SEO RULE, and the quality gate stays
    assert.ok(text.indexOf('BUSINESS FACTS / SEMANTIC SAFETY RULE:') < text.indexOf('SEO RULE:'))
    assert.ok(text.includes('CONTENT QUALITY GATE:') && text.includes('3. Выдуманные факты.'))
    // old absolute coverage wording must be gone
    assert.ok(!text.includes('каждая значимая тема/search intent внутри кластера должна быть покрыта.'))
    assert.ok(!text.includes('каждая значимая тема/search intent внутри каждого кластера должна быть покрыта.'))
    assert.ok(!text.includes('Страница полностью отвечает'))
  }
})

// A. Create shares the Improve factual guardrail and its guarded coverage wording.
test('Create prompt carries the same business-facts guardrail as Improve', () => {
  for (const intent of ['commercial', 'informational', 'mixed']) {
    const create = buildCreateTask(project, single(intent), 'ru')
    const improve = buildImproveTask(project, single(intent), page, 'ru')
    const block = (t: string) => t.slice(t.indexOf('BUSINESS FACTS / SEMANTIC SAFETY RULE:'), t.indexOf('SEO RULE:'))
    assert.ok(create.includes('BUSINESS FACTS / SEMANTIC SAFETY RULE:'))
    assert.equal(block(create), block(improve))
    assert.ok(create.indexOf('BUSINESS FACTS / SEMANTIC SAFETY RULE:') < create.indexOf('SEO RULE:'))
    assert.ok(create.includes('НЕ являются источником фактов о бизнесе'))
    assert.ok(create.includes('Intentionally not covered:\n- <topic/query> — not confirmed by project facts'))
    assert.ok(create.includes('CANDIDATE SEPARATE PAGES\n- <тема>'))
    assert.ok(!create.includes('каждая значимая тема/search intent внутри кластера должна быть покрыта.'))
  }
  // semantics is demand, not business facts: services, cities, audiences, prices, guarantees, terms, certificates
  const create = buildCreateTask(project, single('commercial'), 'ru')
  for (const s of ['новую услугу', 'конкретного города/района', 'конкретной аудиторией', 'цену, скидку, гарантию, срок', 'сертификат']) assert.ok(create.includes(s), s)
})

// B. No project-specific (olnoo.com) CTA text; the universal rule stays.
test('CTA rule is project-agnostic in Create and Improve', () => {
  const texts = [
    buildCreateTask(project, single('commercial'), 'ru'),
    buildCreateTask(project, single('informational'), 'ru'),
    buildImproveTask(project, single('commercial'), page, 'ru'),
    buildImproveTask(project, single('informational'), page, 'ru'),
    buildImproveTaskForPage(project, [body, lights], pages, 7)!,
  ]
  for (const text of texts) {
    assert.ok(!text.includes('Специально для этого проекта'))
    assert.ok(!text.includes('contact form'))
    assert.ok(text.includes('Для любого проекта:'))
    assert.ok(text.includes('использовать существующий CTA / contact / conversion flow этого проекта'))
    assert.ok(text.includes('сначала посмотреть CTA ближайших service pages'))
    assert.ok(text.includes('не создавать новую форму без необходимости'))
    assert.ok(text.includes('не менять существующую логику отправки заявок и уведомлений'))
    assert.ok(text.includes('сохранять существующий design pattern CTA'))
  }
})

// C. Create does not require a /ru/ or /en/ prefix; it follows the project's own URL structure.
test('Create URL rule follows the project structure (no mandatory language prefix)', () => {
  for (const locale of ['ru', 'en', 'kk']) {
    const text = buildCreateTask({ name: 'DriveSet', domain: 'driveset.ru', locale }, single('commercial'), locale)
    assert.ok(!text.includes('RU → /ru/'), locale)
    assert.ok(!text.includes('/ru/...') && !text.includes('/en/...'), locale)
    assert.ok(!text.includes('соответствует locale'), locale)
    assert.ok(text.includes('следует существующей URL-структуре проекта'), locale)
    assert.ok(text.includes('без языкового префикса (/ru/, /en/ и т. п.), если проект его не использует'), locale)
    assert.ok(text.includes('сохрани его для языка этой страницы'), locale)
    assert.ok(text.includes(`Locale: ${locale}`), locale)
  }
  // a DriveSet-style page (/polirovka-avto, no prefix) stays a normal Improve target
  const improve = buildImproveTaskForPage({ ...project, locale: 'ru' }, [body], pages, 7)!
  assert.ok(improve.includes('https://driveset.ru/polirovka-avto') && !improve.includes('/ru/') && !improve.includes('/en/'))
})

// D. Improve language: the page's own language, then the project's, then the clusters', then the default.
test('Improve locale: page, then project, then clusters, then default', () => {
  const neutral = (loc: string | null): PageOption => ({ id: 30, url: 'https://driveset.ru/polirovka-avto', locale: loc, title: null, h1: null, description: null })
  const ruCluster = row({ id: 60, name: 'Полировка', confirmedPageId: 30 })
  const enCluster = row({ id: 61, name: 'Car polishing', confirmedPageId: 30 })
  const locOf = (proj: { name: string; domain: string; locale?: string | null }, cl: ImproveClusterInput, pg: PageOption) =>
    /Locale: (\S+)/.exec(buildImproveTaskForPage(proj, [cl], [pg], 30)!)![1]
  // stored page locale wins over the project locale
  assert.equal(locOf({ ...project, locale: 'en' }, ruCluster, neutral('ru')), 'ru')
  assert.equal(locOf({ ...project, locale: 'ru' }, enCluster, neutral('en')), 'en')
  // URL prefix wins over everything
  assert.equal(locOf({ ...project, locale: 'en' }, enCluster, { ...neutral(null), url: 'https://driveset.ru/ru/polirovka' }), 'ru')
  // language-neutral page: the project locale (even if it is not ru|en, and normalised)
  assert.equal(locOf({ ...project, locale: 'ru' }, enCluster, neutral(null)), 'ru')
  assert.equal(locOf({ ...project, locale: ' KK ' }, ruCluster, neutral(null)), 'kk')
  assert.equal(locOf({ ...project, locale: 'de' }, ruCluster, neutral('de')), 'de')
  // no page and no project locale: the clusters' language, then the safe default
  assert.equal(locOf(project, ruCluster, neutral(null)), 'ru')
  assert.equal(locOf(project, enCluster, neutral(null)), 'en')
  assert.equal(locOf({ ...project, locale: '' }, { ...ruCluster, primaryKeyword: null }, neutral(null)), 'en')
  // aggregation of several confirmed clusters is unchanged by the project locale
  const text = buildImproveTaskForPage({ ...project, locale: 'ru' }, [body, lights], pages, 7)!
  assert.ok(text.includes('SEO clusters страницы (2):') && text.includes('Name: Полировка кузова') && text.includes('Name: Полировка фар') && text.includes('Locale: ru'))
})

// E. The AI/GEO checks live inside the existing CONTENT QUALITY GATE (no separate block, no special AI files).
test('Quality Gate includes AI/GEO checks in Create and Improve', () => {
  const texts = [buildCreateTask(project, single('commercial'), 'ru'), buildImproveTask(project, single('commercial'), page, 'ru'), buildImproveTaskForPage(project, [body, lights], pages, 7)!]
  for (const text of texts) {
    const gate = text.slice(text.indexOf('CONTENT QUALITY GATE:'), text.indexOf('Не менять существующий визуальный стиль сайта.'))
    assert.ok(gate.includes('8. AI / GEO-читаемость (часть обычной Search SEO, не отдельный текст).'))
    for (const s of [
      'ответ на основной intent страницы ясен сразу, без keyword stuffing',
      'структура страницы однозначна для поисковых и AI-систем',
      'важные business facts (кто, что, где, условия) сформулированы явно и непротиворечиво',
      'FAQ используется только там, где он действительно полезен',
      'не создан отдельный GEO/AEO-текст: обычная Search SEO остаётся основой',
      'не добавлены llms.txt, новая schema.org-разметка и другие специальные AI-файлы',
      'factual guardrail (BUSINESS FACTS / SEMANTIC SAFETY RULE) соблюдён',
      'AI/GEO readiness:\nPASS / FIXED / FAIL',
    ]) assert.ok(gate.includes(s), s)
    assert.equal(text.split('CONTENT QUALITY GATE:').length - 1, 1) // no second gate
    assert.ok(!/GEO[- ]?(agent|section)/i.test(text.replace('не создан отдельный GEO/AEO-текст', '')))
  }
})

// Create and Improve share the same main guardrails (one intent = one page, no thin pages, internal links, coverage check).
test('Create and Improve share the main guardrails', () => {
  const create = buildCreateTask(project, single('commercial'), 'ru')
  const improve = buildImproveTask(project, single('commercial'), page, 'ru')
  for (const text of [create, improve]) {
    for (const s of ['BUSINESS FACTS / SEMANTIC SAFETY RULE:', 'INTERNAL LINKS RULE:', 'COVERAGE CHECK:', 'CONTENT QUALITY GATE:',
      'Не создавай отдельные страницы под близкие запросы одного search intent.', 'только подтверждённые фактами проекта',
      'Не делать keyword stuffing.']) assert.ok(text.includes(s), s)
  }
  assert.ok(create.includes('не создавать страницы под отдельные синонимы этого же cluster'))
  // Create suggests links to the new page without editing other pages; Improve links on the page itself
  assert.ok(create.includes('Не изменяй эти страницы автоматически без явной необходимости'))
  assert.ok(improve.includes('Ссылки можно добавить прямо на странице'))
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

test('locale follows the target page, not the cluster order', () => {
  const ruPage: PageOption = { id: 20, url: 'https://driveset.ru/ru/polirovka', locale: null, title: null, h1: null, description: null }
  const enPage: PageOption = { id: 21, url: 'https://driveset.ru/en/polish', locale: null, title: null, h1: null, description: null }
  const en = row({ id: 10, name: 'Headlight polish', totalFrequency: 5000, confirmedPageId: 20 })
  const ru = row({ id: 11, name: 'Полировка', totalFrequency: 10, confirmedPageId: 20 })
  assert.ok(buildImproveTaskForPage(project, [en, ru], [ruPage], 20)!.includes('Locale: ru'))
  const ru2 = row({ id: 12, name: 'Полировка', confirmedPageId: 21 })
  assert.ok(buildImproveTaskForPage(project, [ru2], [enPage], 21)!.includes('Locale: en'))
})

test('navigational clusters stay out of the content scope (A + B(nav) + C)', () => {
  const a = row({ id: 31, name: 'Оклейка авто', intent: 'commercial', totalFrequency: 3000, primaryKeyword: 'оклейка авто' })
  const nav = row({ id: 32, name: 'Бренд Икс', intent: 'navigational', totalFrequency: 800, primaryKeyword: 'бренд икс', keywords: [{ query: 'бренд икс отзывы', frequency: 800 }] })
  const c = row({ id: 33, name: 'Защитная оклейка', intent: 'informational', totalFrequency: 1200, primaryKeyword: 'защитная оклейка' })
  const text = buildImproveTaskForPage(project, [nav, c, a], pages, 7)!
  assert.equal(text.split('Задача:').length - 1, 1)
  const scopeStart = text.indexOf('Content scope — SEO clusters страницы, обязательные для content coverage (2):')
  const analyticsStart = text.indexOf('Аналитические кластеры страницы (1)')
  assert.ok(scopeStart >= 0 && analyticsStart > scopeStart)
  const scope = text.slice(scopeStart, analyticsStart)
  assert.ok(scope.includes('Name: Оклейка авто') && scope.includes('Name: Защитная оклейка'))
  assert.ok(!scope.includes('Бренд Икс'))
  // excluded cluster: listed by name only for analytics, no primary keyword / keywords anywhere
  assert.ok(text.includes('- Бренд Икс (intent: navigational, total frequency: 800)'))
  assert.ok(!text.includes('Primary keyword: бренд икс') && !text.includes('бренд икс отзывы') && !text.includes('Name: Бренд Икс'))
  assert.ok(text.includes('НЕ создавать новую страницу.'))
})

test('single content cluster + navigational one: classic cluster block plus analytics block', () => {
  const nav = row({ id: 41, name: 'Бренд Икс', intent: 'navigational' })
  const text = buildImproveTaskForPage(project, [lights, nav], pages, 7)!
  assert.ok(text.includes('SEO cluster:') && text.includes('Name: Полировка фар'))
  assert.ok(text.includes('Аналитические кластеры страницы (1)') && !text.includes('Name: Бренд Икс'))
})

test('only navigational clusters confirmed for the page → no task', () => {
  const n1 = row({ id: 51, name: 'Бренд Икс', intent: 'navigational' })
  const n2 = row({ id: 52, name: 'Бренд Игрек', intent: 'navigational' })
  assert.equal(buildImproveTaskForPage(project, [n1, n2], pages, 7), null)
})

test('no navigational clusters → prompt identical to before the filter', () => {
  const a = buildImproveTaskForPage(project, [body, lights], pages, 7)!
  assert.ok(a.includes('SEO clusters страницы (2):') && !a.includes('Аналитические кластеры страницы'))
})
