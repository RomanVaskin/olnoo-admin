import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { QUERIES_TOOL_NAME, toQueriesDto, TOP_QUERIES_LIMIT } from './mcp-direct-queries.ts'
import { handleMcpRequest, SUMMARY_PERIODS, SUMMARY_TOOL_NAME } from './mcp-summary.ts'

const NOW = new Date('2026-10-07T09:00:00Z')
const PERIOD = { complete: false, preset: 'today' }
const row = (i: number, over: Record<string, unknown> = {}) => ({
  campaignId: 1, adGroupId: 10 + (i % 3), query: `q${i}`, criteria: 'c', criteriaType: 'KEYWORD', targetingCategory: 'EXACT', impressions: 10, clicks: 2, spend: i, cpc: 0.5, ...over,
})
const payload = (rows: unknown[], structure?: unknown) =>
  ({
    period: { from: '2026-10-07', to: '2026-10-07' },
    campaign: { id: 714796268, name: 'C', state: 'ON', settings: { dailyBudget: { amount: 1 }, strategy: {} }, totals: {} },
    searchQueries: rows,
    structure,
    daily: [{ date: 'x' }], meta: { requestIds: ['r1'], units: 'u' },
  }) as never
const STRUCT = { adGroups: [{ id: 1, name: 'secret group' }], adGroupsTruncated: false, keywords: { items: [{ keyword: 'kw', bid: 5 }], truncated: false },
  negativeKeywords: { campaign: ['бесплатно'], campaignSharedSetIds: [7], adGroups: [{ adGroupId: 11, phrases: ['авито'], sharedSetIds: [] }] } }

test('DTO: top 50 by spend (ties by clicks, then query), with the pre-cut total and a truncated flag', () => {
  const rows = Array.from({ length: 80 }, (_, i) => row(i))
  const d = toQueriesDto(payload(rows, STRUCT), PERIOD, NOW)
  assert.equal(d.queries.length, TOP_QUERIES_LIMIT)
  assert.equal(d.totalQueries, 80)
  assert.equal(d.truncated, true)
  assert.deepEqual(d.queries.slice(0, 3).map((q) => q.query), ['q79', 'q78', 'q77'])
  assert.equal(d.queries.at(-1)!.query, 'q30')
  const tie = toQueriesDto(payload([row(1, { spend: 5, clicks: 1, query: 'b' }), row(2, { spend: 5, clicks: 9, query: 'z' }), row(3, { spend: 5, clicks: 9, query: 'a' })], STRUCT), PERIOD, NOW)
  assert.deepEqual(tie.queries.map((q) => q.query), ['a', 'z', 'b'])
  assert.equal(toQueriesDto(payload(rows.slice(0, 5), STRUCT), PERIOD, NOW).truncated, false)
})

test('DTO: exactly the whitelisted fields; nothing else leaks (settings, bids, keywords, group names, request ids, targetingCategory)', () => {
  const d = toQueriesDto(payload([row(1, { criteria: '---autotargeting', criteriaType: 'AUTOTARGETING' })], STRUCT), PERIOD, NOW)
  assert.deepEqual(Object.keys(d), ['period', 'campaignId', 'totalQueries', 'truncated', 'queries', 'negativeKeywords', 'generatedAt'])
  assert.deepEqual(Object.keys(d.queries[0]), ['query', 'criteria', 'criteriaType', 'adGroupId', 'impressions', 'clicks', 'spend', 'cpc', 'isAutotargeting'])
  assert.deepEqual(d.period, { from: '2026-10-07', to: '2026-10-07', complete: false, preset: 'today' })
  assert.equal(d.queries[0].isAutotargeting, true)
  assert.equal(d.generatedAt, NOW.toISOString())
  const text = JSON.stringify(d)
  for (const w of ['secret group', 'targetingCategory', 'EXACT', 'bid', 'dailyBudget', 'requestIds', 'r1', 'units', 'daily', 'phone', 'email', 'contact', 'name"']) assert.ok(!text.includes(w), w)
  assert.deepEqual(d.negativeKeywords, { complete: true, campaign: ['бесплатно'], campaignSharedSetIds: [7], adGroups: [{ adGroupId: 11, phrases: ['авито'], sharedSetIds: [] }] })
  assert.equal(toQueriesDto(payload([row(1)], STRUCT), PERIOD, NOW).queries[0].isAutotargeting, false)
})

test('DTO: empty and missing cases are honest (no queries; no structure ⇒ complete=false, never "nothing excluded"; null stays null)', () => {
  const empty = toQueriesDto(payload([], STRUCT), PERIOD, NOW)
  assert.deepEqual([empty.queries, empty.totalQueries, empty.truncated], [[], 0, false])
  const noStruct = toQueriesDto(payload([row(1, { cpc: null, adGroupId: null })]), PERIOD, NOW)
  assert.deepEqual(noStruct.negativeKeywords, { complete: false, campaign: [], campaignSharedSetIds: [], adGroups: [] })
  assert.equal(noStruct.queries[0].cpc, null)
  assert.equal(noStruct.queries[0].adGroupId, null)
  const cut = toQueriesDto(payload([row(1)], { ...STRUCT, adGroupsTruncated: true }), PERIOD, NOW)
  assert.equal(cut.negativeKeywords.complete, false)
})
