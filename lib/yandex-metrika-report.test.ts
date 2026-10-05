import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_DIMENSIONS,
  ALLOWED_METRIC_RE,
  breakdownQuery,
  buildMetrikaPayload,
  checkGoals,
  dailyQuery,
  DIM,
  goalsQuery,
  OBSERVED_GOALS,
  parseManagedGoals,
  parseStatResponse,
  ReportFormatError,
  type PayloadInput,
  type StatResponse,
} from './yandex-metrika-report.ts'

const period = { from: '2026-10-03', to: '2026-10-05', timezone: 'Europe/Moscow' as const, complete: false, preset: 'custom' as const }
const resp = (rows: StatResponse['rows'], extra: Partial<StatResponse> = {}): StatResponse => ({ rows, totals: [], totalRows: rows.length, sampled: false, sampleShare: 1, dataLagSeconds: 0, ...extra })
const empty = { response: resp([]) }

function input(overrides: Partial<PayloadInput> = {}): PayloadInput {
  const goalValues = OBSERVED_GOALS.flatMap((g) => {
    const reaches: Record<string, number> = { quiz_start: 38, car_selected: 30, package_selected: 30, quiz_phone: 30, lead_submit: 5, telegram_click: 6, max_click: 2, phone_click: 1 }
    const visits: Record<string, number> = { quiz_start: 30, car_selected: 25, package_selected: 24, quiz_phone: 24, lead_submit: 3, telegram_click: 5, max_click: 2, phone_click: 1 }
    return [reaches[g.event], visits[g.event]]
  })
  return {
    project: 'driveset',
    counter: { id: 113053562, timezone: 'Europe/Moscow' },
    period,
    now: new Date('2026-10-05T09:00:00Z'),
    goalCheck: checkGoals(null),
    daily: resp([{ dimensions: [{ id: null, name: '2026-10-03' }], metrics: [12, 11, 83.3333, 10.9167] }, { dimensions: [{ id: null, name: '2026-10-05' }], metrics: [9, 9, 77.7778, 175.1111] }], { totals: [21, 20, 80.9524, 87.2] }),
    goals: resp([{ dimensions: [], metrics: goalValues }]),
    sources: empty,
    utm: empty,
    directCampaigns: empty,
    directBanners: empty,
    directPhrasesOrConditions: empty,
    directSearchPhrases: { response: resp([{ dimensions: [{ id: null, name: 'оклейка авто' }], metrics: [4, 4, 50, 60, 1, 1] }]) },
    requests: 9,
    ...overrides,
  }
}

test('queries: only allowed dimensions and visit/goal metrics; no visitor-level dimension can be built', () => {
  const queries = [dailyQuery(), goalsQuery(OBSERVED_GOALS), breakdownQuery([DIM.utmSource, DIM.utmMedium, DIM.utmCampaign, DIM.utmContent, DIM.utmTerm], true), breakdownQuery([DIM.directSearchPhrase], false)]
  for (const query of queries) {
    assert.ok(query.dimensions.every((d) => ALLOWED_DIMENSIONS.includes(d)))
    assert.ok(query.metrics.every((m) => ALLOWED_METRIC_RE.test(m)))
    assert.ok(query.metrics.length <= 20) // Reporting API limit per request
  }
  assert.ok(!ALLOWED_DIMENSIONS.some((d) => /clientID|yclid|userID|visitID/i.test(d)))
  assert.ok(!ALLOWED_METRIC_RE.test('ym:s:clientID') && !ALLOWED_METRIC_RE.test('ym:s:goalXreaches'))
  assert.deepEqual(goalsQuery(OBSERVED_GOALS).metrics.slice(0, 2), ['ym:s:goal664270022reaches', 'ym:s:goal664270022visits'])
})

test('parseStatResponse: rows, totals, sampling, data lag; unreadable → ReportFormatError', () => {
  const parsed = parseStatResponse({ data: [{ dimensions: [{ name: 'a', id: 7 }, { name: '' }], metrics: [1, 'x', null] }], totals: [1], total_rows: 3, sampled: true, sample_share: 0.25, data_lag: 30 })
  assert.deepEqual(parsed.rows[0], { dimensions: [{ id: '7', name: 'a' }, { id: null, name: null }], metrics: [1, null, null] })
  assert.deepEqual([parsed.totalRows, parsed.sampled, parsed.sampleShare, parsed.dataLagSeconds], [3, true, 0.25, 30])
  assert.throws(() => parseStatResponse({}), ReportFormatError)
  assert.throws(() => parseStatResponse(null), ReportFormatError)
})

test('goal list: exact conditions are read; missing goals and changed conditions are reported', () => {
  const managed = parseManagedGoals({ goals: [{ id: 663848261, name: 'x', type: 'action', conditions: [{ type: 'exact', url: 'lead_submit' }] }, { id: 1, conditions: [{ type: 'contain', url: 'z' }] }, { name: 'no id' }] })
  assert.deepEqual(managed.map((g) => [g.id, g.events]), [[663848261, ['lead_submit']], [1, []]])
  const check = checkGoals(managed)
  assert.equal(check.present.length, 1)
  assert.equal(check.missing.length, OBSERVED_GOALS.length - 1)
  assert.equal(check.warnings.filter((w) => w.code === 'goal_missing').length, OBSERVED_GOALS.length - 1)
  assert.throws(() => parseManagedGoals({}), ReportFormatError)
})

test('payload: totals, zero-filled daily, goals with reaches AND visitsWithGoal, funnel by visits', () => {
  const p = buildMetrikaPayload(input())
  assert.deepEqual(p.totals, { visits: 21, users: 20, bounceRate: 80.95, avgVisitDurationSeconds: 87.2 })
  assert.deepEqual(p.daily.map((d) => [d.date, d.visits]), [['2026-10-03', 12], ['2026-10-04', 0], ['2026-10-05', 9]])
  const lead = p.goals.find((g) => g.event === 'lead_submit')!
  assert.deepEqual([lead.id, lead.reaches, lead.visitsWithGoal, lead.found], [663848261, 5, 3, true])
  assert.deepEqual(p.funnel.map((s) => [s.step, s.visits, s.reaches]), [
    ['visit', 21, null], ['quiz_start', 30, 38], ['car_selected', 25, 30], ['package_selected', 24, 30], ['quiz_phone', 24, 30], ['lead_submit', 3, 5],
  ])
  assert.equal(p.funnel[3].conversionFromPreviousPct, 96)
  assert.equal(p.funnel[5].conversionFromVisitsPct, 14.29)
  assert.ok(p.warnings.some((w) => w.code === 'funnel_not_monotonic')) // 30 quiz_start visits > 21 total in this fixture
})

test('payload: period.complete and the incomplete-period warning', () => {
  assert.equal(buildMetrikaPayload(input()).period.complete, false)
  assert.ok(buildMetrikaPayload(input()).warnings.some((w) => w.code === 'incomplete_period'))
  const done = buildMetrikaPayload(input({ period: { ...period, complete: true } }))
  assert.equal(done.period.complete, true)
  assert.ok(!done.warnings.some((w) => w.code === 'incomplete_period'))
})

test('payload: sampling, truncation and empty search phrases are warnings, never errors', () => {
  const sampled = buildMetrikaPayload(input({ sources: { response: resp([], { sampled: true, sampleShare: 0.3, dataLagSeconds: 90 }) } }))
  assert.equal(sampled.meta.sampled, true)
  assert.equal(sampled.meta.sampling.minSampleShare, 0.3)
  assert.equal(sampled.meta.dataLagSeconds, 90)
  assert.ok(sampled.warnings.some((w) => w.code === 'sampled'))
  const cut = buildMetrikaPayload(input({ utm: { response: resp([{ dimensions: [{ id: null, name: 'yandex' }], metrics: [1, 1, 0, 5, 0, 0] }], { totalRows: 250 }) } }))
  assert.ok(cut.warnings.some((w) => w.code === 'rows_truncated'))
  const none = buildMetrikaPayload(input({ directSearchPhrases: empty }))
  assert.ok(none.warnings.some((w) => w.code === 'search_phrase_no_data'))
  assert.equal(buildMetrikaPayload(input()).meta.sampled, false)
})

test('payload: breakdown rows carry no identifiers; lead goal shown per row; limits are stated', () => {
  const p = buildMetrikaPayload(input())
  assert.deepEqual(p.direct.searchPhrases[0], { searchPhrase: { id: null, name: 'оклейка авто' }, visits: 4, users: 4, bounceRate: 50, avgVisitDurationSeconds: 60, leadSubmitReaches: 1, leadSubmitVisits: 1 })
  assert.doesNotMatch(JSON.stringify(p), /clientID|client_id|yclid|userID|visitID|"phone"|"contact"/i)
  assert.ok(p.meta.limitations.some((l) => l.startsWith('Direct → Metrika: AGGREGATED')))
  assert.deepEqual(p.meta.attributionModel, { sources: 'lastsign', utm: 'lastsign', direct: 'lastDirectClick' })
})

// ---- Unified Analytics extras -------------------------------------------------------------------------

import {
  ALLOWED_FILTER_RE,
  dailyGoalsQuery,
  directSegmentQuery,
  matchesTestRules,
  parseDailyGoals,
  parseDirectSegment,
  parseTestSegment,
  SEGMENT_EVENTS,
  testSegmentQuery,
} from './yandex-metrika-report.ts'

const RULES = { utmContent: ['a2_production_test'], utmTerm: ['test_attribution'] }

test('extras queries: only allowed dimensions/metrics, within the 20-metric limit; the test filter has the allowed shape', () => {
  const test = testSegmentQuery(RULES)!
  for (const query of [dailyGoalsQuery(), directSegmentQuery(), test]) {
    assert.ok(query.dimensions.every((d) => ALLOWED_DIMENSIONS.includes(d)))
    assert.ok(query.metrics.every((m) => ALLOWED_METRIC_RE.test(m)))
    assert.ok(query.metrics.length <= 20)
  }
  assert.equal(test.filters, "ym:s:lastsignUTMContent=='a2_production_test' OR ym:s:lastsignUTMTerm=='test_attribution'") // legacy-only rules
  const withPair = testSegmentQuery({ ...RULES, utmPairs: [{ source: 'olnoo', medium: 'test' }] })!
  assert.equal(withPair.filters, "(ym:s:lastsignUTMSource=='olnoo' AND ym:s:lastsignUTMMedium=='test') OR ym:s:lastsignUTMContent=='a2_production_test' OR ym:s:lastsignUTMTerm=='test_attribution'")
  assert.ok(ALLOWED_FILTER_RE.test(withPair.filters!))
  assert.ok(!ALLOWED_FILTER_RE.test("ym:s:lastsignUTMSource=='olnoo' AND ym:s:clientID=='1'"))
  assert.throws(() => testSegmentQuery({ ...RULES, utmPairs: [{ source: "x' OR '1'='1", medium: 'test' }] }), ReportFormatError)
  assert.ok(ALLOWED_FILTER_RE.test(test.filters!))
  assert.ok(!ALLOWED_FILTER_RE.test("ym:s:clientID=='1'"))
  assert.ok(!ALLOWED_FILTER_RE.test("ym:s:lastsignUTMContent=='x' OR 1=1"))
  assert.equal(testSegmentQuery({ utmContent: [], utmTerm: [] }), null)
  assert.throws(() => testSegmentQuery({ utmContent: ["x' OR '1'='1"], utmTerm: [] }), ReportFormatError)
  assert.equal(directSegmentQuery().dimensions[0], 'ym:s:lastDirectClickOrder')
  assert.equal(dailyGoalsQuery().metrics.length, 2)
})

test('test rules: exact normalised match only — substrings, other "test" strings and empty values are not test traffic', () => {
  assert.equal(matchesTestRules(RULES, 'a2_production_test', null), true)
  assert.equal(matchesTestRules(RULES, ' A2_Production_Test ', ''), true) // normalised
  assert.equal(matchesTestRules(RULES, null, 'test_attribution'), true)
  assert.equal(matchesTestRules(RULES, 'a2_production_test_2', null), false) // not a substring rule
  assert.equal(matchesTestRules(RULES, 'my_test_page', 'тест'), false)
  assert.equal(matchesTestRules(RULES, 'test', 'test'), false)
  assert.equal(matchesTestRules(RULES, '1922380925577514960', '---autotargeting'), false)
  assert.equal(matchesTestRules(RULES, '', ''), false)
  assert.equal(matchesTestRules({ utmContent: [''], utmTerm: [''] }, '', ''), false)
})

test('direct segment: matched by lastDirectClickOrder.id (exact), never by name or UTM', () => {
  const metrics = (visits: number) => [visits, ...SEGMENT_EVENTS.flatMap((_, i) => [10 + i, 20 + i])]
  const r = resp([
    { dimensions: [{ id: '999', name: 'Единая перфоманс-кампания №4 от 25-09-2026' }], metrics: metrics(5) },
    { dimensions: [{ id: '714796268', name: 'Другое имя' }], metrics: metrics(66) },
  ])
  const seg = parseDirectSegment(r, 714796268)
  assert.deepEqual([seg.found, seg.idsPresent, seg.visits], [true, true, 66])
  assert.deepEqual(seg.goals.quiz_start, { visits: 10, reaches: 20 })
  assert.deepEqual(seg.goals.phone_click, { visits: 17, reaches: 27 })
  const byNameOnly = parseDirectSegment(resp([{ dimensions: [{ id: null, name: '714796268' }], metrics: metrics(3) }]), 714796268)
  assert.deepEqual([byNameOnly.found, byNameOnly.idsPresent, byNameOnly.visits], [false, false, 0])
  assert.deepEqual([parseDirectSegment(resp([]), 714796268).found, parseDirectSegment(resp([]), 714796268).idsPresent], [false, true])
})

test('new test UTM pair: source AND medium both required; either alone, or other mediums, are not test traffic', () => {
  const R = { ...RULES, utmPairs: [{ source: 'olnoo', medium: 'test' }] }
  assert.equal(matchesTestRules(R, null, null, 'olnoo', 'test'), true)
  assert.equal(matchesTestRules(R, '', '', ' OLNOO ', 'Test'), true)
  assert.equal(matchesTestRules(R, null, null, 'olnoo', 'cpc'), false)
  assert.equal(matchesTestRules(R, null, null, 'yandex', 'test'), false)
  assert.equal(matchesTestRules(R, null, null, 'olnoo', ''), false)
  assert.equal(matchesTestRules(R, 'olnoo_test', null, 'yandex', 'cpc'), false) // content alone is not a rule
  assert.equal(matchesTestRules(RULES, null, null, 'olnoo', 'test'), false) // no pair configured
})

test('test segment and daily goals are parsed; rows that fail the exact rule are ignored', () => {
  const row = (content: string, term: string, visits: number, source = 'x', medium = 'y') => ({ dimensions: [{ id: null, name: source }, { id: null, name: medium }, { id: null, name: content }, { id: null, name: term }], metrics: [visits, ...SEGMENT_EVENTS.map(() => 1), 3] })
  const seg = parseTestSegment(resp([row('a2_production_test', 'test_attribution', 1), row('other', 'test_attribution', 2), row('other', 'x', 50)]), RULES)
  assert.deepEqual([seg.visits, seg.rows, seg.goalVisits.lead_submit, seg.leadSubmitReaches], [3, 2, 2, 6])
  const pair = parseTestSegment(resp([row('c', 't', 4, 'olnoo', 'test'), row('c', 't', 9, 'olnoo', 'cpc')]), { ...RULES, utmPairs: [{ source: 'olnoo', medium: 'test' }] })
  assert.deepEqual([pair.visits, pair.rows], [4, 1])
  assert.deepEqual(parseDailyGoals(resp([{ dimensions: [{ id: null, name: '2026-10-05' }], metrics: [7, 3] }, { dimensions: [], metrics: [1, 1] }])), [{ date: '2026-10-05', quizStartVisits: 7, leadSubmitVisits: 3 }])
})
