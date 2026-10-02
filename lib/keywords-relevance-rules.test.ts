import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyConfidenceThreshold,
  buildProjectContext,
  cleanReason,
  decide,
  parseRelevanceResponse,
  planRelevanceBatches,
  RELEVANCE_CONFIDENCE_THRESHOLDS,
  RELEVANCE_CONTEXT_PAGES,
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
    { keywordId: 1, status: 'target', confidence: 92, reason: 'Основная услуга проекта' },
    { keywordId: 2, status: 'irrelevant', confidence: 88, reason: 'x' },
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
