import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyConfidenceThreshold,
  buildProjectContext,
  cleanReason,
  decide,
  parseRelevanceResponse,
  regionsOverlap,
  planRelevanceBatches,
  contextCaps,
  contextPageCount,
  normalizeSeoContext,
  seoContextKnowsBusiness,
  seoContextKnowsRegion,
  RELEVANCE_CONFIDENCE_THRESHOLDS,
  RELEVANCE_CONTEXT_PAGES,
  RELEVANCE_SYSTEM_PROMPT,
  relevanceMaxOutputTokens,
} from './keywords-relevance-rules.ts'

test('confidence below the status threshold forces "uncertain"; at or above keeps the status; uncertain stays', () => {
  for (const status of ['target', 'informational', 'irrelevant', 'geo_mismatch'] as const) {
    const t = RELEVANCE_CONFIDENCE_THRESHOLDS[status]
    assert.deepEqual(applyConfidenceThreshold(status, t - 1), { status: 'uncertain', downgraded: true }, `${status} below`)
    assert.deepEqual(applyConfidenceThreshold(status, t), { status, downgraded: false }, `${status} at threshold`)
  }
  assert.deepEqual(applyConfidenceThreshold('uncertain', 5), { status: 'uncertain', downgraded: false })
  // Excluding needs more certainty than including.
  assert.ok(RELEVANCE_CONFIDENCE_THRESHOLDS.irrelevant > RELEVANCE_CONFIDENCE_THRESHOLDS.target)
})

test('a downgraded decision keeps a short Russian explanation with the original reason', () => {
  const d = decide('irrelevant', 40, 'Запрос не относится к бизнесу проекта')
  assert.equal(d.status, 'uncertain')
  assert.equal(d.downgraded, true)
  assert.match(d.reason, /^Низкая уверенность AI \(40%\): Запрос не относится/)
})

test('reasons: one line, capped, Russian — otherwise a stock Russian reason', () => {
  assert.equal(cleanReason('Основная услуга\n  проекта', 'target'), 'Основная услуга проекта')
  assert.equal(cleanReason('Main service of the project', 'target'), 'Целевой запрос по услуге проекта')
  assert.equal(cleanReason('', 'geo_mismatch'), 'Указан регион, который проект не обслуживает')
  assert.ok(cleanReason('а'.repeat(500), 'target').length <= 160)
})

test('AI answer validation: unknown ids/statuses/confidences and repeats are dropped; unusable answers are null', () => {
  const sent = new Set([1, 2, 3])
  const items = parseRelevanceResponse(
    JSON.stringify({
      results: [
        { keyword_id: 1, relevance_status: 'target', confidence: 91.6, reason: 'Основная услуга проекта', query: 'changed!' },
        { keyword_id: '2', relevance_status: 'IRRELEVANT', confidence: '88', reason: 'x' },
        { keyword_id: 2, relevance_status: 'target', confidence: 99 },
        { keyword_id: 3, relevance_status: 'maybe', confidence: 50 },
        { keyword_id: 3, relevance_status: 'target' },
        { keyword_id: 99, relevance_status: 'target', confidence: 90 },
      ],
    }),
    sent,
  )
  assert.deepEqual(items, [
    { keywordId: 1, status: 'target', confidence: 92, reason: 'Основная услуга проекта' , queryRegion: '' },
    { keywordId: 2, status: 'irrelevant', confidence: 88, reason: 'x' , queryRegion: '' },
  ])
  assert.equal(parseRelevanceResponse('not json', sent), null)
  assert.equal(parseRelevanceResponse('{"results":"nope"}', sent), null)
  assert.equal(parseRelevanceResponse('{"results":[{"keyword_id":99,"relevance_status":"target","confidence":90}]}', sent), null)
  assert.equal(parseRelevanceResponse('```json\n{"results":[{"keyword_id":1,"relevance_status":"target","confidence":90}]}\n```', sent)?.length, 1)
})

test('batches: same query text sent once, never split, capped by count and chars', () => {
  const rows = Array.from({ length: 5200 }, (_, i) => ({ id: i + 1, query: `запрос ${Math.floor(i / 2)}` }))
  const batches = planRelevanceBatches(rows, { batchSize: 100 })
  assert.equal(batches.flat().length, 2600)
  assert.ok(batches.every((b) => b.length <= 100))
  assert.equal(batches.flat().flatMap((g) => g.ids).length, 5200)
  assert.ok(batches.flat().every((g) => g.ids.length === 2))
  assert.ok(planRelevanceBatches(rows.slice(0, 50), { batchSize: 100, maxChars: 200 }).length > 1)
})

test('project context is compact: capped page list, clipped fields, no page data tolerated', () => {
  const pages = Array.from({ length: 200 }, (_, i) => ({ url: `https://x.ru/p${i}`, title: `Заголовок ${i}`, h1: null, description: 'д'.repeat(1000) }))
  const ctx = buildProjectContext({ name: 'Проект', domain: 'https://x.ru' }, pages)
  assert.equal(ctx.split('\n').filter((l) => l.startsWith('- ')).length, RELEVANCE_CONTEXT_PAGES)
  assert.ok(ctx.length < 20000)
  assert.match(ctx, /PROJECT: Проект \(https:\/\/x\.ru\)/)
  assert.match(buildProjectContext({ name: 'P', domain: 'd' }, []), /no page data available/)
})

test('without page data an exclusion is never saved (held as uncertain); target/informational are unaffected', () => {
  for (const status of ['geo_mismatch', 'irrelevant'] as const) {
    const d = decide(status, 99, 'Запрос не относится к бизнесу проекта', false)
    assert.deepEqual({ status: d.status, held: d.held, downgraded: d.downgraded }, { status: 'uncertain', held: true, downgraded: false })
    assert.match(d.reason, status === 'irrelevant' ? /Нет данных о проекте/ : /Регион проекта не задан/)
    assert.equal(decide(status, 99, 'Причина', true).status, status, 'with context the exclusion stands')
  }
  assert.equal(decide('target', 90, 'Основная услуга проекта', false).status, 'target')
  assert.equal(decide('informational', 90, 'Информационный запрос по теме проекта', false).status, 'informational')
})

test('the prompt makes a city a geo_mismatch only against a region the context names', () => {
  assert.match(RELEVANCE_SYSTEM_PROMPT, /NEVER get "geo_mismatch"/)
  assert.match(RELEVANCE_SYSTEM_PROMPT, /NEVER a reason for "geo_mismatch"/)
  assert.equal(contextPageCount([{ url: 'https://x/', title: null, h1: null, description: null }, { url: 'https://x/a', title: 'T', h1: null, description: null }]), 1)
})

test('exclusions need what they exclude against: irrelevant needs a known business, geo_mismatch a known region', () => {
  const noRegion = { business: true, region: false }
  const noBusiness = { business: false, region: true }
  assert.equal(decide('geo_mismatch', 99, 'Другой регион', noRegion).status, 'uncertain')
  assert.equal(decide('geo_mismatch', 99, 'Другой регион', noRegion).held, true)
  assert.equal(decide('irrelevant', 99, 'Не относится к бизнесу проекта', noRegion).status, 'irrelevant')
  assert.equal(decide('irrelevant', 99, 'Не относится к бизнесу проекта', noBusiness).status, 'uncertain')
  assert.equal(decide('geo_mismatch', 99, 'Другой регион', noBusiness).status, 'geo_mismatch')
})

test('SEO context: normalised and capped; knows business / region; pages are an alternative source', () => {
  const ctx = normalizeSeoContext({ businessType: '  автомобильный\n детейлинг ', region: 'Москва', services: ' оклейка \r\n полировка ', plannedServices: 5, excluded: 'x'.repeat(5000) })
  assert.equal(ctx.businessType, 'автомобильный детейлинг')
  assert.equal(ctx.services, 'оклейка \n полировка')
  assert.equal(ctx.plannedServices, '')
  assert.equal(ctx.excluded.length, 2000)
  assert.equal(seoContextKnowsBusiness(ctx), true)
  assert.equal(seoContextKnowsRegion(ctx), true)
  assert.equal(seoContextKnowsBusiness({ ...ctx, businessType: '', services: '' }), false)
  assert.equal(seoContextKnowsBusiness(null), false)
  const page = [{ url: 'https://x/', title: 'T', h1: null, description: null }]
  assert.deepEqual(contextCaps(null, []), { business: false, region: false })
  assert.deepEqual(contextCaps(null, page), { business: true, region: true })
  assert.deepEqual(contextCaps({ ...ctx, region: '' }, []), { business: true, region: false })
})

test('project context for the AI carries the explicit SEO context, planned directions and exclusions', () => {
  const text = buildProjectContext(
    { name: 'Проект', domain: 'https://x.ru' },
    [],
    normalizeSeoContext({ businessType: 'автодетейлинг', region: 'Москва', services: 'оклейка\nполировка', plannedServices: 'оклейка фургонов', excluded: 'пылесосы; полировальные машинки' }),
  )
  assert.match(text, /BUSINESS TYPE: автодетейлинг/)
  assert.match(text, /TARGET REGION: Москва/)
  assert.match(text, /MAIN SERVICES[^\n]*\n- оклейка\n- полировка/)
  assert.match(text, /PLANNED[^\n]*\n- оклейка фургонов/)
  assert.match(text, /NOT OFFERED[^\n]*\n- пылесосы\n- полировальные машинки/)
  assert.match(buildProjectContext({ name: 'P', domain: 'd' }, []), /BUSINESS TYPE: \(not specified\)/)
})

test('regionsOverlap: oblast towns overlap the target region, other regions do not (no city lists)', () => {
  const target = 'Москва + Московская область'
  for (const place of ['Московская область', 'Москва', 'г. Москва', 'Московская обл.']) assert.equal(regionsOverlap(place, target), true, place)
  for (const place of ['Приморский край', 'Ростовская область', 'Краснодарский край', '', 'Санкт-Петербург']) assert.equal(regionsOverlap(place, target), false, place)
  assert.equal(regionsOverlap('Ленинградская область', 'Санкт-Петербург и Ленинградская область'), true)
  assert.equal(regionsOverlap('Московская область', 'Ленинградская область'), false)
})

test('decide: with an explicit target region geo_mismatch needs a query_region outside it', () => {
  const geo = (queryRegion: string) => ({ queryRegion, targetRegion: 'Москва + Московская область' })
  const caps = { business: true, region: true }
  const inside = decide('geo_mismatch', 95, 'Другой регион', caps, geo('Московская область'))
  assert.deepEqual({ status: inside.status, geoRejected: inside.geoRejected }, { status: 'uncertain', geoRejected: true })
  assert.equal(decide('geo_mismatch', 95, 'Другой регион', caps, geo('')).geoRejected, true)
  const outside = decide('geo_mismatch', 95, 'Другой регион', caps, geo('Приморский край'))
  assert.deepEqual({ status: outside.status, geoRejected: outside.geoRejected }, { status: 'geo_mismatch', geoRejected: false })
  assert.equal(decide('target', 95, 'Основная услуга', caps, geo('')).status, 'target')
  // Region known only from pages (no explicit target region): behaviour as before.
  assert.equal(decide('geo_mismatch', 95, 'Другой регион', caps).status, 'geo_mismatch')
})

test('parseRelevanceResponse keeps query_region', () => {
  const raw = JSON.stringify({ results: [{ keyword_id: 1, relevance_status: 'geo_mismatch', confidence: 90, reason: 'x', query_region: ' Приморский   край ' }, { keyword_id: 2, relevance_status: 'target', confidence: 90, reason: 'x' }] })
  const items = parseRelevanceResponse(raw, new Set([1, 2]))!
  assert.equal(items[0].queryRegion, 'Приморский край')
  assert.equal(items[1].queryRegion, '')
})

// ---- Compact answer format ----

const SENT = new Set([1, 2, 3, 4, 5, 6])
const compact = (rows: unknown[]) => JSON.stringify({ r: rows })

test('compact rows are restored into the same internal classification objects', () => {
  const items = parseRelevanceResponse(
    compact([
      [1, 't', 98],
      [2, 'i', 91],
      [3, 'u', 55, 'Нужно решение: сегмент не подтверждён'],
      [4, 'x', 96, 'Запрос не относится к бизнесу проекта'],
      [5, 'g', 97, 'Приморский край', 'Указан регион вне региона проекта'],
    ]),
    SENT,
  )!
  assert.deepEqual(items, [
    { keywordId: 1, status: 'target', confidence: 98, reason: '', queryRegion: '' },
    { keywordId: 2, status: 'informational', confidence: 91, reason: '', queryRegion: '' },
    { keywordId: 3, status: 'uncertain', confidence: 55, reason: 'Нужно решение: сегмент не подтверждён', queryRegion: '' },
    { keywordId: 4, status: 'irrelevant', confidence: 96, reason: 'Запрос не относится к бизнесу проекта', queryRegion: '' },
    { keywordId: 5, status: 'geo_mismatch', confidence: 97, reason: 'Указан регион вне региона проекта', queryRegion: 'Приморский край' },
  ])
})

test('target / informational without an AI reason get the server default reason; uncertain and geo reasons are kept', () => {
  const [t, i, u, g] = parseRelevanceResponse(
    compact([[1, 't', 90], [2, 'i', 80], [3, 'u', 60, 'Неясный интент запроса'], [4, 'g', 90, 'Ростовская область', 'Другой регион']]),
    SENT,
  )!
  assert.equal(decide(t.status, t.confidence, t.reason).reason, 'Целевой запрос по услуге проекта')
  assert.equal(decide(i.status, i.confidence, i.reason).reason, 'Информационный запрос по теме проекта')
  assert.equal(decide(u.status, u.confidence, u.reason).reason, 'Неясный интент запроса')
  const geo = decide(g.status, g.confidence, g.reason, true, { queryRegion: g.queryRegion, targetRegion: 'Москва' })
  assert.deepEqual({ status: geo.status, reason: geo.reason, geoRejected: geo.geoRejected }, { status: 'geo_mismatch', reason: 'Другой регион', geoRejected: false })
  assert.equal(g.queryRegion, 'Ростовская область')
})

test('a geo row without a reason gets one that names the region (no extra output tokens needed)', () => {
  const [g] = parseRelevanceResponse(compact([[1, 'g', 90, 'Приморский край']]), SENT)!
  assert.equal(g.reason, 'Указан другой регион: Приморский край')
  assert.equal(g.queryRegion, 'Приморский край')
})

test('malformed or partial compact output never invents a classification: bad rows are dropped, unusable answers are null', () => {
  const items = parseRelevanceResponse(
    compact([
      [1, 't', 98],
      [2], // too short
      [3, 'z', 90], // unknown status code
      [4, 't', 'high'], // no numeric confidence
      'oops',
      [99, 't', 90], // id that was not sent
      [1, 'x', 99, 'Повтор'], // repeated id: first one wins
      [6, 'i', 70],
    ]),
    SENT,
  )!
  assert.deepEqual(items.map((x) => [x.keywordId, x.status]), [[1, 'target'], [6, 'informational']])
  assert.equal(parseRelevanceResponse(compact([[2], 'oops']), SENT), null)
  assert.equal(parseRelevanceResponse('{"r":[[1,"t",98],[2,"i"', SENT), null, 'a truncated answer is unusable, not half-saved')
  assert.equal(parseRelevanceResponse('Конечно! Вот результат', SENT), null)
  assert.equal(parseRelevanceResponse('{"r":"nope"}', SENT), null)
})

test('the previous verbose object answer is still accepted', () => {
  const items = parseRelevanceResponse(
    JSON.stringify({ results: [{ keyword_id: 1, relevance_status: 'geo_mismatch', confidence: 90, reason: 'Другой регион', query_region: 'Приморский край' }] }),
    SENT,
  )!
  assert.deepEqual(items, [{ keywordId: 1, status: 'geo_mismatch', confidence: 90, reason: 'Другой регион', queryRegion: 'Приморский край' }])
})

test('the prompt asks for the compact form: no reason for target/informational, no query echo', () => {
  assert.match(RELEVANCE_SYSTEM_PROMPT, /\{"r":\[\[keyword_id,"t",confidence\]/)
  assert.match(RELEVANCE_SYSTEM_PROMPT, /"t" and "i": exactly \[keyword_id,code,confidence\] — NO reason/)
  assert.match(RELEVANCE_SYSTEM_PROMPT, /Do not repeat the query text/)
  assert.doesNotMatch(RELEVANCE_SYSTEM_PROMPT, /"results"/)
})

test('output token limit is derived from the batch, doubled on retry and capped at the Router default', () => {
  assert.equal(relevanceMaxOutputTokens(100), 5500)
  assert.equal(relevanceMaxOutputTokens(1), 1045)
  assert.equal(relevanceMaxOutputTokens(100, 1), 11000)
  assert.equal(relevanceMaxOutputTokens(250, 1), 12000)
})

// ---- informational questions about materials / tools are not irrelevant ----

const HOWTO_QUERIES = [
  'какая химия нужна для химчистки салона автомобиля',
  'какую пасту взять для полировки фар',
  'какие полировальные круги нужны для полировки фар',
  'какая машинка должна быть для полировки авто',
]

test('prompt: how-to-choose questions about materials/tools/equipment are informational, not irrelevant, even when listed in NOT OFFERED', () => {
  assert.match(RELEVANCE_SYSTEM_PROMPT, /which materials, chemicals, pastes, pads\/wheels, tools or equipment are needed or how to choose them/)
  for (const example of ['какая химия нужна для химчистки салона', 'какую пасту взять для полировки фар', 'какие круги нужны для полировки', 'какая машинка нужна для полировки авто']) {
    assert.ok(RELEVANCE_SYSTEM_PROMPT.includes(example), example)
  }
  assert.match(RELEVANCE_SYSTEM_PROMPT, /never "irrelevant" just because the item is listed in NOT OFFERED/)
  assert.match(RELEVANCE_SYSTEM_PROMPT, /NOT irrelevant — it is "informational"/)
  // Buying the goods themselves is still excluded.
  assert.match(RELEVANCE_SYSTEM_PROMPT, /intent is to BUY \/ order \/ rent \/ sell something in NOT OFFERED/)
  // The NOT OFFERED label in the context block carries the same distinction.
  const text = buildProjectContext({ name: 'P', domain: 'd' }, [], { businessType: 'детейлинг', region: 'Москва', services: 'полировка фар', plannedServices: '', excluded: 'полировальные пасты' })
  assert.match(text, /NOT OFFERED[^\n]*how-to-choose[^\n]*"informational"/)
  assert.equal(HOWTO_QUERIES.length, 4)
})
