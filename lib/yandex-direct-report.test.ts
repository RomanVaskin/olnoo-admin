import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DAILY_FIELDS,
  SEARCH_QUERY_FIELDS,
  dailyReport,
  observerPeriod,
  parseReportTsv,
  ReportFormatError,
  searchQueryReport,
  toDailyRows,
  toSearchQueryRows,
  microsToMoney,
} from './yandex-direct-report.ts'

const tsv = (fields: string[], ...rows: string[][]) =>
  ['"olnoo-observer-test (2026-09-27_2026-10-03)"', fields.join('\t'), ...rows.map((r) => r.join('\t')), `Total rows: ${rows.length}`].join('\n')

test('TSV parser: skips the title line, stops at the summary, maps columns', () => {
  const text = tsv(DAILY_FIELDS, ['2026-10-01', '714796268', '120', '9', '1234500000'], ['2026-10-02', '714796268', '--', '--', '--'])
  const rows = parseReportTsv(text, DAILY_FIELDS)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { Date: '2026-10-01', CampaignId: '714796268', Impressions: '120', Clicks: '9', Cost: '1234500000' })
  assert.equal(rows[1].Cost, '--')
})

test('TSV parser: no data rows is an empty list; missing column row or a ragged row is an error', () => {
  assert.deepEqual(parseReportTsv(tsv(DAILY_FIELDS), DAILY_FIELDS), [])
  assert.throws(() => parseReportTsv('garbage', DAILY_FIELDS), ReportFormatError)
  assert.throws(() => parseReportTsv([DAILY_FIELDS.join('\t'), 'a\tb'].join('\n'), DAILY_FIELDS), ReportFormatError)
})

test('money: micros → rubles, deterministic CPC, "--" is zero, rows are sorted', () => {
  assert.equal(microsToMoney(1_234_500_000), 1234.5)
  const daily = toDailyRows(
    parseReportTsv(tsv(DAILY_FIELDS, ['2026-10-02', '1', '--', '--', '--'], ['2026-10-01', '1', '120', '9', '1234500000']), DAILY_FIELDS),
  )
  assert.deepEqual(daily.map((d) => d.date), ['2026-10-01', '2026-10-02'])
  assert.deepEqual(daily[0], { date: '2026-10-01', impressions: 120, clicks: 9, spend: 1234.5, cpc: 137.17 })
  assert.deepEqual(daily[1], { date: '2026-10-02', impressions: 0, clicks: 0, spend: 0, cpc: null })
})

test('search query rows: autotargeting stays raw, TargetingCategory is optional compatibility data', () => {
  const rows = toSearchQueryRows(
    parseReportTsv(
      tsv(
        SEARCH_QUERY_FIELDS,
        ['1', '10', 'оклейка авто', 'оклейка авто', 'KEYWORD', '--', '50', '2', '100000000'],
        ['1', '10', 'ppf цена', '---autotargeting', 'AUTOTARGETING', 'BROADER', '80', '5', '900000000'],
      ),
      SEARCH_QUERY_FIELDS,
    ),
  )
  assert.equal(rows[0].query, 'ppf цена') // highest spend first
  assert.equal(rows[0].criteriaType, 'AUTOTARGETING')
  assert.equal(rows[0].criteria, '---autotargeting')
  assert.equal(rows[0].targetingCategory, 'BROADER')
  assert.equal(rows[1].targetingCategory, null)
  assert.equal(rows[0].spend, 900)
  assert.equal(rows[0].cpc, 180)

  const without = toSearchQueryRows([{ CampaignId: '1', AdGroupId: '10', Query: 'q', Criteria: 'q', CriteriaType: 'KEYWORD', Impressions: '1', Clicks: '0', Cost: '0' }])
  assert.equal('targetingCategory' in without[0], false)
})

test('report definitions carry every required parameter and are deterministic', () => {
  const a = dailyReport(714796268, '2026-09-27', '2026-10-03')
  const b = dailyReport(714796268, '2026-09-27', '2026-10-03')
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  for (const def of [a, searchQueryReport(714796268, '2026-09-27', '2026-10-03')]) {
    const p = def.params
    assert.ok(p.ReportName && p.ReportType && p.DateRangeType === 'CUSTOM_DATE' && p.Format === 'TSV' && p.IncludeVAT)
    assert.deepEqual(p.SelectionCriteria.Filter, [{ Field: 'CampaignId', Operator: 'EQUALS', Values: ['714796268'] }])
  }
  assert.ok(searchQueryReport(1, 'a', 'b').params.FieldNames.includes('TargetingCategory'))
  assert.ok(!searchQueryReport(1, 'a', 'b', false).params.FieldNames.includes('TargetingCategory'))
})

test('period: last N complete days in Moscow time, ending yesterday', () => {
  assert.deepEqual(observerPeriod(new Date('2026-10-04T10:00:00Z'), 7), { from: '2026-09-27', to: '2026-10-03' })
  // 22:00 UTC is already the next day in Moscow
  assert.deepEqual(observerPeriod(new Date('2026-10-03T22:00:00Z'), 1), { from: '2026-10-03', to: '2026-10-03' })
})
