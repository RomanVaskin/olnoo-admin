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
