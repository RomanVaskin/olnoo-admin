import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { LeadSignal, LeadSignalsPayload } from './crm-observer.ts'
import { resolveObserverPeriod, type ResolvedPeriod } from './observer-period.ts'
import {
  buildUnifiedPayload,
  collectSources,
  isAutotargetingPhrase,
  isDirectLead,
  isTestSignal,
  resolveUnifiedProject,
  summarizeCrm,
  TEST_TRAFFIC_RULES,
  UNIFIED_PROJECTS,
  unifiedHttpStatus,
  type MetrikaBundle,
  type SourceResult,
  type Sources,
} from './unified-analytics.ts'
import { parseDirectSegment, SEGMENT_EVENTS, type DirectSegment, type MetrikaPayload, type TestSegment, type UnifiedExtras } from './yandex-metrika-report.ts'
import type { ObserverPayload as DirectPayload } from './yandex-direct-report.ts'

const NOW = new Date('2026-10-05T09:00:00Z') // 12:00 Moscow, 2026-10-05
const CAMPAIGN = 714796268
const project = UNIFIED_PROJECTS.driveset
const period = (s: string) => resolveObserverPeriod(new URLSearchParams(s), NOW) as ResolvedPeriod

// ---- fixtures ------------------------------------------------------------------------------------

function directPayload(over: { clicks?: number; spend?: number; impressions?: number; daily?: DirectPayload['daily'] } = {}): DirectPayload {
  const clicks = over.clicks ?? 150
  const spend = over.spend ?? 7500
  return {
    period: { from: '2026-10-04', to: '2026-10-04' },
    campaign: {
      id: CAMPAIGN, name: 'Единая перфоманс-кампания', state: 'ON', status: 'ACCEPTED', type: 'UNIFIED_CAMPAIGN', startDate: '2026-09-25',
      settings: {} as never,
      totals: { impressions: over.impressions ?? 3000, clicks, spend, cpc: clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : null },
    },
    daily: over.daily ?? [{ date: '2026-10-04', impressions: 3000, clicks, spend, cpc: clicks > 0 ? spend / clicks : null }],
    searchQueries: [
      { campaignId: CAMPAIGN, adGroupId: 1, query: 'оклейка авто пленкой', criteria: '---autotargeting', criteriaType: 'AUTOTARGETING', impressions: 500, clicks: 30, spend: 1500, cpc: 50 },
      { campaignId: CAMPAIGN, adGroupId: 1, query: 'Оклейка авто пленкой ', criteria: 'оклейка авто пленкой', criteriaType: 'KEYWORD', impressions: 100, clicks: 10, spend: 600, cpc: 60 },
      { campaignId: CAMPAIGN, adGroupId: 1, query: 'бронепленка москва', criteria: 'бронепленка', criteriaType: 'KEYWORD', impressions: 50, clicks: 2, spend: 100, cpc: 50 },
    ],
    meta: { includeVat: true, units: null, requestIds: [] },
  }
}

const goalRow = (event: string, visits: number | null, reaches: number | null, found = true) => ({ id: 1, name: event, event, found, reaches, visitsWithGoal: visits })

function metrikaPayload(over: { visits?: number; sampled?: boolean; warnings?: { code: string; message: string }[] } = {}): MetrikaPayload {
  return {
    totals: { visits: over.visits ?? 108, users: 90, bounceRate: 66.5, avgVisitDurationSeconds: 40.1 },
    daily: [{ date: '2026-10-04', visits: over.visits ?? 108, users: 90, bounceRate: 66.5, avgVisitDurationSeconds: 40.1 }],
    goals: [
      goalRow('quiz_start', 28, 38), goalRow('car_selected', 23, 30), goalRow('package_selected', 22, 30), goalRow('quiz_phone', 21, 30),
      goalRow('lead_submit', 2, 5), goalRow('telegram_click', 5, 6), goalRow('max_click', 2, 2), goalRow('phone_click', 1, 1),
    ],
    direct: {
      campaigns: [], banners: [],
      phrasesOrConditions: [{ phraseOrCondition: { id: null, name: 'Autotargeting' }, visits: 30, users: 28, bounceRate: 76.67, avgVisitDurationSeconds: 11.27, leadSubmitVisits: 0, leadSubmitReaches: 0 }],
      searchPhrases: [{ searchPhrase: { id: null, name: 'оклейка авто пленкой' }, visits: 12, users: 11, bounceRate: 50, avgVisitDurationSeconds: 60, leadSubmitVisits: 0, leadSubmitReaches: 0 }],
    },
    warnings: over.warnings ?? [],
    meta: { sampled: over.sampled ?? false },
  } as unknown as MetrikaPayload
}

function segment(visits = 66): DirectSegment {
  const goals = Object.fromEntries(SEGMENT_EVENTS.map((e, i) => [e, { visits: 10 + i, reaches: 20 + i }]))
  return { campaignId: CAMPAIGN, found: true, idsPresent: true, visits, goals }
}
function testSegment(): TestSegment {
  return { visits: 1, goalVisits: { ...Object.fromEntries(SEGMENT_EVENTS.map((e) => [e, 0])), quiz_start: 1, car_selected: 1, package_selected: 1, quiz_phone: 1, lead_submit: 1 }, leadSubmitReaches: 3, rows: 1 }
}
function extras(over: Partial<UnifiedExtras> = {}): UnifiedExtras {
  return { dailyGoals: [{ date: '2026-10-04', quizStartVisits: 28, leadSubmitVisits: 2 }], directSegment: segment(), testSegment: testSegment(), sampled: false, warnings: [], ...over }
}

const signal = (over: Partial<LeadSignal> = {}): LeadSignal => ({
  createdAt: '2026-10-04T09:00:00.000Z', status: 'New', utmSource: 'yandex', utmMedium: 'cpc', utmCampaign: String(CAMPAIGN), utmContent: '1922380925577514960', utmTerm: '---autotargeting',
  hasMetrikaClientId: true, hasYclid: true, ...over,
})
const crmPayload = (signals: LeadSignal[], over: Partial<LeadSignalsPayload> = {}): LeadSignalsPayload => ({
  period: {} as never, project: { id: 1, slug: 'driveset', name: 'DriveSet' }, total: signals.length, truncated: false, signals, ...over,
})

const ok = <T>(data: T): SourceResult<T> => ({ status: 'ok', data })
const down = <T>(kind = 'network'): SourceResult<T> => ({ status: 'unavailable', error: { kind, message: 'x' }, data: null })

function sources(over: Partial<Sources> = {}): Sources {
  const leads = [signal(), signal({ utmSource: 'ya' }), signal({ utmSource: 'google' }), signal({ utmCampaign: '', utmSource: '' }), signal({ utmSource: 'chatgpt.com', utmContent: 'a2_production_test', utmTerm: 'test_attribution' })]
  return {
    direct: ok(directPayload()),
    metrika: ok<MetrikaBundle>({ payload: metrikaPayload(), extras: extras() }),
    crm: ok(crmPayload(leads)),
    ...over,
  }
}
const build = (s: Sources, p = period('period=yesterday')) => buildUnifiedPayload({ project: 'driveset', config: project, period: p, now: NOW, sources: s })

// ---- config / test traffic ----------------------------------------------------------------------

test('project mapping: driveset → campaign 714796268 and CRM slug driveset; others are unknown', () => {
  assert.deepEqual([project.campaignId, project.crmSlug], [CAMPAIGN, 'driveset'])
  assert.equal(resolveUnifiedProject('driveset'), project)
  for (const slug of ['olnoo', 'all', '__proto__', 'constructor']) assert.equal(resolveUnifiedProject(slug), null)
})

test('test traffic: explicit exact markers only; arbitrary "test" strings are not classified', () => {
  assert.deepEqual(TEST_TRAFFIC_RULES.driveset, { utmContent: ['a2_production_test'], utmTerm: ['test_attribution'] })
  assert.equal(isTestSignal(project.testRules, signal({ utmContent: 'a2_production_test' })), true)
  assert.equal(isTestSignal(project.testRules, signal({ utmTerm: ' Test_Attribution ' })), true)
  for (const [content, term] of [['test', 'test'], ['my_test', 'тест'], ['a2_production_test_old', ''], ['1922380925577514960', '---autotargeting'], ['', '']]) {
    assert.equal(isTestSignal(project.testRules, signal({ utmContent: content, utmTerm: term })), false, `${content}|${term}`)
  }
})

// ---- CRM ------------------------------------------------------------------------------------------

test('CRM Direct rule: utm_campaign == campaign id AND utm_source in yandex/ya; known test traffic is excluded; everything else is unattributed', () => {
  assert.equal(isDirectLead(project, signal()), true)
  assert.equal(isDirectLead(project, signal({ utmSource: ' YA ' })), true)
  assert.equal(isDirectLead(project, signal({ utmSource: 'google' })), false)
  assert.equal(isDirectLead(project, signal({ utmCampaign: '1' })), false)
  assert.equal(isDirectLead(project, signal({ utmCampaign: '' , utmSource: 'yandex' })), false)
  assert.equal(isDirectLead(project, signal({ utmContent: 'a2_production_test' })), false) // yandex + campaign id, but a known test lead

  const crm = summarizeCrm(sources().crm, project)
  assert.deepEqual([crm.leads, crm.testLeads, crm.leadsDirect, crm.leadsUnattributed], [5, 1, 2, 2])
  assert.deepEqual(crm.byStatus, { New: 4 }) // the test lead is not in the status split
  assert.equal(crm.perDay!.get('2026-10-04'), 4)
})

test('CRM days are Moscow days (21:00 UTC rolls over)', () => {
  const crm = summarizeCrm(ok(crmPayload([signal({ createdAt: '2026-10-04T20:59:00.000Z' }), signal({ createdAt: '2026-10-04T21:00:00.000Z' })])), project)
  assert.deepEqual([...crm.perDay!.entries()], [['2026-10-04', 1], ['2026-10-05', 1]])
})

// ---- payload: happy path ---------------------------------------------------------------------------

test('payload: Direct, Metrika, funnel (all / excluding test / Direct segment), contact intents and conversions', () => {
  const p = build(sources())
  assert.deepEqual(p.direct, { status: 'ok', complete: true, campaign: { id: CAMPAIGN, name: 'Единая перфоманс-кампания' }, impressions: 3000, clicks: 150, spend: 7500, ctr: 5, cpc: 50, includesVat: true })
  assert.deepEqual(p.period, { from: '2026-10-04', to: '2026-10-04', timezone: 'Europe/Moscow', complete: true, preset: 'yesterday' })

  assert.equal(p.metrika.visits, 108)
  assert.equal(p.metrika.directClickVisits, 66) // from the lastDirectClickOrder.id segment, not from UTM
  assert.deepEqual(p.metrika.excludingTest, { visits: 107, leadSubmitVisits: 1 })
  assert.equal(p.metrika.sampled, false)

  assert.deepEqual(p.funnel, {
    scope: 'all_visits', quizStartVisits: 28, carSelectedVisits: 23, packageSelectedVisits: 22, quizPhoneVisits: 21, leadSubmitVisits: 2, leadSubmitReaches: 5,
    excludingTest: { quizStartVisits: 27, carSelectedVisits: 22, packageSelectedVisits: 21, quizPhoneVisits: 20, leadSubmitVisits: 1, leadSubmitReaches: 2 },
    direct: { scope: 'direct_click', quizStartVisits: 10, carSelectedVisits: 11, packageSelectedVisits: 12, quizPhoneVisits: 13, leadSubmitVisits: 14, leadSubmitReaches: 24 },
  })
  assert.deepEqual(p.contactIntentVisits, { telegram: 5, max: 2, phone: 1, direct: { telegram: 15, max: 16, phone: 17 } }) // never summed

  assert.equal(p.conversions.basis, 'excluding_test')
  assert.deepEqual(p.conversions.clickToVisitPct, { value: 44 }) // 66 / 150
  assert.deepEqual(p.conversions.visitToQuizPct, { value: 25.23 }) // 27 / 107
  assert.deepEqual(p.conversions.quizToContactPct, { value: 74.07 }) // 20 / 27
  assert.deepEqual(p.conversions.visitToMetrikaLeadPct, { value: 0.93 }) // 1 / 107
  assert.deepEqual(p.conversions.visitToCrmLeadPct, { value: 3.03 }) // 2 direct CRM leads / 66
  assert.deepEqual(p.conversions.clickToCrmLeadPct, { value: 1.33 }) // 2 / 150
  assert.deepEqual(p.conversions.cpl, { value: 3750, attributionConfidence: 'AGGREGATED' }) // 7500 / 2
  assert.deepEqual(p.testTraffic, { detected: true, metrikaVisits: 1, metrikaLeadSubmitVisits: 1, crmLeads: 1, rulesApplied: { utmContent: ['a2_production_test'], utmTerm: ['test_attribution'], match: 'exact_normalized_or' } })
  assert.equal(p.attribution.directToMetrika.status, 'EXACT_CAMPAIGN_AGGREGATED_VISITS')
  assert.deepEqual(p.attribution.directToMetrika.evidence, ['campaign_id_match'])
  assert.equal(p.attribution.metrikaToCrm.status, 'AGGREGATED')
  assert.equal(p.attribution.overall.status, 'AGGREGATED')
  assert.ok(p.warnings.some((w) => w.code === 'funnel_not_strict'))
})

// ---- CPL ----------------------------------------------------------------------------------------------

test('CPL: period_incomplete for today, whatever else is true', () => {
  const p = build(sources(), period('period=today'))
  assert.equal(p.period.complete, false)
  assert.equal(p.direct.complete, false)
  assert.deepEqual(p.conversions.cpl, { value: null, reason: 'period_incomplete' })
  assert.ok(p.warnings.some((w) => w.code === 'incomplete_period'))
  // an explicit range that includes today is incomplete too
  assert.equal(build(sources(), period('from=2026-10-01&to=2026-10-05')).conversions.cpl.reason, 'period_incomplete')
})

test('CPL: no_attributed_leads (never a fake zero), no_spend, crm_truncated, source failures', () => {
  const noLeads = sources({ crm: ok(crmPayload([signal({ utmSource: 'chatgpt.com', utmContent: 'a2_production_test' })])) })
  assert.deepEqual(build(noLeads).conversions.cpl, { value: null, reason: 'no_attributed_leads' })
  assert.deepEqual(build(sources({ direct: ok(directPayload({ spend: 0, clicks: 3 })) })).conversions.cpl, { value: null, reason: 'no_spend' })
  assert.deepEqual(build(sources({ crm: { status: 'partial', data: crmPayload([signal()], { total: 3000, truncated: true }) } })).conversions.cpl, { value: null, reason: 'crm_truncated' })
  assert.deepEqual(build(sources({ direct: down() })).conversions.cpl, { value: null, reason: 'direct_unavailable' })
  assert.deepEqual(build(sources({ crm: down('crm_error') })).conversions.cpl, { value: null, reason: 'crm_unavailable' })
})

test('derived metrics: zero denominators give a reason, not NaN/Infinity', () => {
  const noClicks = build(sources({ direct: ok(directPayload({ clicks: 0, spend: 0, impressions: 0 })) }))
  assert.equal(noClicks.direct.ctr, null)
  assert.equal(noClicks.direct.cpc, null)
  assert.deepEqual(noClicks.conversions.clickToVisitPct, { value: null, reason: 'no_clicks' })
  assert.deepEqual(noClicks.conversions.clickToCrmLeadPct, { value: null, reason: 'no_clicks' })
  const noQuiz = build(sources({ metrika: ok<MetrikaBundle>({ payload: { ...metrikaPayload(), goals: metrikaPayload().goals.map((g) => ({ ...g, visitsWithGoal: 0, reaches: 0 })) }, extras: extras({ testSegment: null }) }) }))
  assert.deepEqual(noQuiz.conversions.quizToContactPct, { value: null, reason: 'no_quiz_starts' })
  const noVisits = build(sources({ metrika: ok<MetrikaBundle>({ payload: metrikaPayload({ visits: 0 }), extras: extras({ directSegment: { ...segment(0) } }) }) }))
  assert.deepEqual(noVisits.conversions.visitToCrmLeadPct, { value: null, reason: 'no_direct_visits' })
  assert.doesNotMatch(JSON.stringify(build(sources())), /NaN|Infinity/)
})

// ---- failure policy -------------------------------------------------------------------------------------

test('Direct unavailable (e.g. the current-day report fails): Metrika and CRM are still returned, dependent metrics are null with a reason', () => {
  const p = build(sources({ direct: down('request') }), period('period=today'))
  assert.equal(p.direct.status, 'unavailable')
  assert.deepEqual([p.direct.impressions, p.direct.clicks, p.direct.spend, p.direct.cpc, p.direct.ctr], [null, null, null, null, null])
  assert.equal(p.direct.complete, false)
  assert.equal(p.metrika.visits, 108)
  assert.equal(p.crm.leads, 5)
  assert.deepEqual(p.conversions.clickToVisitPct, { value: null, reason: 'direct_unavailable' })
  assert.equal(p.conversions.visitToQuizPct.value, 25.23)
  assert.ok(p.warnings.some((w) => w.code === 'source_unavailable' && w.source === 'direct'))
  assert.equal(p.attribution.overall.status, 'UNKNOWN')
  assert.equal(p.daily[0].clicks, null)
  assert.notEqual(p.daily[0].visits, null) // Metrika columns are still there
  assert.equal(p.breakdowns.searchQueries.rows.length, 0)
})

test('Metrika unavailable: visit and funnel metrics are null; partial Metrika (no extras) keeps the observer numbers and flags it', () => {
  const none = build(sources({ metrika: down() }))
  assert.equal(none.metrika.visits, null)
  assert.equal(none.funnel.quizStartVisits, null)
  assert.deepEqual(none.conversions.visitToQuizPct, { value: null, reason: 'metrika_unavailable' })
  assert.deepEqual(none.conversions.clickToVisitPct, { value: null, reason: 'metrika_unavailable' })
  assert.equal(none.direct.clicks, 150)

  const partial = build(sources({ metrika: { status: 'partial', data: { payload: metrikaPayload(), extras: null } } }))
  assert.equal(partial.metrika.visits, 108)
  assert.equal(partial.metrika.directClickVisits, null)
  assert.equal(partial.metrika.excludingTest.visits, null)
  assert.equal(partial.conversions.basis, 'raw')
  assert.deepEqual(partial.conversions.clickToVisitPct, { value: null, reason: 'direct_segment_unavailable' })
  assert.equal(partial.testTraffic.metrikaVisits, null)
  assert.ok(partial.warnings.some((w) => w.code === 'source_partial' && w.source === 'metrika'))
})

test('CRM unavailable: CRM metrics and CPL are null; truncated CRM is flagged', () => {
  const p = build(sources({ crm: down('crm_error') }))
  assert.equal(p.crm.leads, null)
  assert.deepEqual(p.conversions.visitToCrmLeadPct, { value: null, reason: 'crm_unavailable' })
  assert.equal(p.daily[0].crmLeads, null)
  const cut = build(sources({ crm: { status: 'partial', data: crmPayload([signal()], { total: 2500, truncated: true }) } }))
  assert.equal(cut.crm.truncated, true)
  assert.equal(cut.crm.leads, 2500)
  assert.ok(cut.warnings.some((w) => w.code === 'crm_truncated'))
})

test('Metrika sampling is reported; low_volume warns but never blocks a calculation', () => {
  const sampled = build(sources({ metrika: ok<MetrikaBundle>({ payload: metrikaPayload({ sampled: true }), extras: extras() }) }))
  assert.equal(sampled.metrika.sampled, true)
  assert.equal(sampled.meta.sampled, true)
  assert.ok(sampled.warnings.some((w) => w.code === 'sampled'))

  const few = build(sources({ direct: ok(directPayload({ clicks: 40, spend: 2000 })) }))
  assert.ok(few.warnings.some((w) => w.code === 'low_volume'))
  assert.equal(few.conversions.cpl.value, 1000) // still calculated
  const enough = sources({ direct: ok(directPayload({ clicks: 150 })), crm: ok(crmPayload(Array.from({ length: 6 }, () => signal()))) })
  assert.ok(!build(enough).warnings.some((w) => w.code === 'low_volume'))
})

// ---- daily / breakdowns -----------------------------------------------------------------------------------

test('daily: merged by Moscow day over the whole period, missing days filled with zeros', () => {
  const p7 = period('period=last7')
  const direct = directPayload({ daily: [{ date: '2026-09-30', impressions: 100, clicks: 4, spend: 200, cpc: 50 }] })
  const s = sources({
    direct: ok(direct),
    metrika: ok<MetrikaBundle>({
      payload: { ...metrikaPayload(), daily: [{ date: '2026-09-30', visits: 9, users: 8, bounceRate: 1, avgVisitDurationSeconds: 1 }] } as MetrikaPayload,
      extras: extras({ dailyGoals: [{ date: '2026-09-30', quizStartVisits: 3, leadSubmitVisits: 1 }] }),
    }),
    crm: ok(crmPayload([signal({ createdAt: '2026-09-30T10:00:00.000Z' })])),
  })
  const p = build(s, p7)
  assert.equal(p.daily.length, 7)
  assert.deepEqual(p.daily[0], { date: '2026-09-28', impressions: 0, clicks: 0, spend: 0, visits: 0, quizStartVisits: 0, leadSubmitVisits: 0, crmLeads: 0 })
  assert.deepEqual(p.daily[2], { date: '2026-09-30', impressions: 100, clicks: 4, spend: 200, visits: 9, quizStartVisits: 3, leadSubmitVisits: 1, crmLeads: 1 })
  assert.equal(p.daily[6].date, '2026-10-04')
})

test('breakdowns: campaign EXACT, autotargeting and search queries AGGREGATED with CRM NOT_SAFE; no query-level CPL', () => {
  const p = build(sources())
  assert.equal(p.breakdowns.campaign.confidence, 'EXACT')
  assert.deepEqual(p.breakdowns.campaign.rows[0].campaign, { id: CAMPAIGN, name: 'Единая перфоманс-кампания' })
  assert.equal(p.breakdowns.campaign.rows[0].metrika!.visits, 66)
  assert.equal(p.breakdowns.autotargeting.confidence, 'AGGREGATED')
  assert.deepEqual(p.breakdowns.autotargeting.sources, { direct: 'EXACT', metrika: 'AGGREGATED', crm: 'NOT_SAFE' })
  assert.deepEqual(p.breakdowns.autotargeting.direct, { impressions: 500, clicks: 30, spend: 1500, cpc: 50 })
  assert.equal(p.breakdowns.autotargeting.metrika!.visits, 30)
  assert.equal(p.breakdowns.autotargeting.crm.confidence, 'NOT_SAFE')
  const q = p.breakdowns.searchQueries
  assert.equal(q.confidence, 'AGGREGATED')
  assert.equal(q.rows[0].query, 'оклейка авто пленкой')
  assert.deepEqual([q.rows[0].clicks, q.rows[0].spend, q.rows[0].cpc], [40, 2100, 52.5]) // two rows of one query joined by normalised text
  assert.deepEqual(q.rows[0].criteriaTypes, ['AUTOTARGETING', 'KEYWORD'])
  assert.equal(q.rows[0].metrika!.visits, 12)
  assert.equal(q.rows[1].metrika, null)
  assert.ok(q.rows.every((r) => !('cpl' in r) && !('crm' in r)))
  assert.deepEqual(p.breakdowns.daily, { confidence: 'AGGREGATED', ref: 'daily' })
})

// ---- orchestration -------------------------------------------------------------------------------------------

test('collectSources: the three sources start concurrently, not one after another', async () => {
  const started: string[] = []
  const gate = Promise.withResolvers<void>()
  const load = <T>(name: string, value: T) => async () => {
    started.push(name)
    await gate.promise
    return value
  }
  const done = collectSources({
    direct: load('direct', directPayload()),
    metrika: load('metrika', { payload: metrikaPayload(), extras: extras() }),
    crm: load('crm', crmPayload([signal()])),
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(started.sort(), ['crm', 'direct', 'metrika']) // all three in flight before any finished
  gate.resolve()
  const s = await done
  assert.deepEqual([s.direct.status, s.metrika.status, s.crm.status], ['ok', 'ok', 'ok'])
})

test('collectSources: one failing source never fails the others; errors are described by kind only', async () => {
  const s = await collectSources({
    direct: async () => { throw Object.assign(new Error('Direct said no'), { kind: 'request' }) },
    metrika: async () => { throw new Error('socket hang up with secret-token-123') },
    crm: async () => crmPayload([signal()], { total: 9, truncated: true }),
  })
  assert.deepEqual(s.direct, { status: 'unavailable', error: { kind: 'request', message: 'Direct said no' }, data: null })
  assert.deepEqual(s.metrika.error, { kind: 'internal', message: 'unexpected failure' }) // an untyped error's text is never exposed
  assert.equal(s.crm.status, 'partial')
  assert.equal(unifiedHttpStatus(s), 200)
})

test('collectSources: a CRM project-not-found answer is a source error; partial Metrika (extras missing) is partial', async () => {
  const s = await collectSources({
    direct: async () => directPayload(),
    metrika: async () => ({ payload: metrikaPayload(), extras: null }),
    crm: async () => ({ error: 'project not found', status: 404 }),
  })
  assert.equal(s.crm.error?.kind, 'project_not_found')
  assert.equal(s.metrika.status, 'partial')
})

test('collectSources: an external source that never answers is cut at the deadline (the CRM is not)', async () => {
  const never = () => new Promise<never>(() => {})
  const s = await collectSources({ direct: never, metrika: never, crm: async () => crmPayload([signal()]) }, 20)
  assert.equal(s.direct.error?.kind, 'timeout')
  assert.equal(s.metrika.error?.kind, 'timeout')
  assert.equal(s.crm.status, 'ok')
})

test('HTTP status: 200 if any source answered; 502 if all failed; 503 only if all are unavailable because nothing is configured', () => {
  assert.equal(unifiedHttpStatus(sources({ direct: down(), metrika: down() })), 200)
  assert.equal(unifiedHttpStatus({ direct: down(), metrika: down(), crm: down('crm_error') }), 502)
  assert.equal(unifiedHttpStatus({ direct: down('not_configured'), metrika: down('not_configured'), crm: down('not_configured') }), 503)
  assert.equal(unifiedHttpStatus({ direct: down('not_configured'), metrika: down('not_configured'), crm: down('crm_error') }), 502)
})

// ---- privacy / route -----------------------------------------------------------------------------------------

test('privacy trap: personal data, ClientID, yclid and tracking ids never reach the unified JSON', () => {
  const traps = { name: 'TRAP-NAME', phone: 'TRAP-PHONE', contact: 'TRAP-CONTACT', email: 'TRAP-EMAIL', metrikaClientId: 'TRAP-CLIENT', clientID: 'TRAP-CLIENT2', yclid: 'TRAP-YCLID', leadTrackingId: 'TRAP-TRACKING', message: 'TRAP-MESSAGE' }
  const dirtySignal = { ...signal(), ...traps } as LeadSignal
  const dirtyMetrika = { ...metrikaPayload(), ...traps, totals: { ...metrikaPayload().totals, ...traps } } as unknown as MetrikaPayload
  const dirtyDirect = { ...directPayload(), ...traps } as unknown as DirectPayload
  const p = build({ direct: ok(dirtyDirect), metrika: ok<MetrikaBundle>({ payload: dirtyMetrika, extras: extras() }), crm: ok(crmPayload([dirtySignal])) })
  const text = JSON.stringify(p)
  assert.doesNotMatch(text, /TRAP-/)
  const keys = new Set<string>()
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x) }
  }
  const { contactIntentVisits: _intents, ...rest } = p // `phone` there is the count of phone-link clicks, not a number
  void _intents
  walk(rest)
  for (const forbidden of ['phone', 'contact', 'email', 'metrikaClientId', 'metrika_client_id', 'clientID', 'clientId', 'yclid', 'hasYclid', 'hasMetrikaClientId', 'leadTrackingId', 'lead_tracking_id']) {
    assert.ok(!keys.has(forbidden), `forbidden key in response: ${forbidden}`)
  }
})

test('route: GET only, reads the libraries directly (no internal HTTP, no full lead rows)', () => {
  const route = readFileSync(new URL('../app/api/ads/unified/route.ts', import.meta.url), 'utf8')
  assert.deepEqual([...route.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]), ['GET'])
  assert.doesNotMatch(route, /\bfetch\(|api\/ads\/yandex-direct\/observer|api\/metrika\/observer|api\/crm\/observer/)
  assert.doesNotMatch(route, /readLeadsForPeriod/)
  assert.match(route, /readLeadSignalsForPeriod/)
  assert.match(route, /observePeriod/)
  const lib = readFileSync(new URL('./unified-analytics.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(lib, /readLeadsForPeriod|ObserverLead\b/)
})

// ---- regression: EXACT campaign match needs the campaign's own row ----------------------------------------------

test('attribution.directToMetrika: EXACT only when the campaign id row was found; empty, other-campaign and id-less answers are UNKNOWN', () => {
  const metricValues = [5, ...SEGMENT_EVENTS.flatMap(() => [1, 2])]
  const answer = (rows: { id: string | null; name: string }[]) =>
    parseDirectSegment({ rows: rows.map((r) => ({ dimensions: [r], metrics: metricValues })), totals: [], totalRows: rows.length, sampled: false, sampleShare: null, dataLagSeconds: null }, CAMPAIGN)
  const attributionFor = (seg: DirectSegment) => build(sources({ metrika: ok<MetrikaBundle>({ payload: metrikaPayload(), extras: extras({ directSegment: seg }) }) })).attribution.directToMetrika

  const empty = answer([])
  assert.deepEqual([empty.found, empty.idsPresent], [false, true]) // the case behind the bug
  const emptyAttribution = attributionFor(empty)
  assert.equal(emptyAttribution.status, 'UNKNOWN')
  assert.deepEqual(emptyAttribution.evidence, [])
  assert.equal((emptyAttribution as { reason?: string }).reason, 'campaign_id_not_found')

  const other = answer([{ id: '123456', name: 'Another campaign' }])
  assert.deepEqual([other.found, other.idsPresent], [false, true])
  const otherAttribution = attributionFor(other)
  assert.equal(otherAttribution.status, 'UNKNOWN')
  assert.ok(!otherAttribution.evidence.includes('campaign_id_match'))

  const noIds = answer([{ id: null, name: String(CAMPAIGN) }])
  const noIdsAttribution = attributionFor(noIds)
  assert.equal(noIdsAttribution.status, 'UNKNOWN')
  assert.deepEqual(noIdsAttribution.evidence, [])
  assert.equal((noIdsAttribution as { reason?: string }).reason, 'campaign_ids_missing')

  const right = answer([{ id: '123456', name: 'Another campaign' }, { id: String(CAMPAIGN), name: 'DriveSet' }])
  assert.deepEqual([right.found, right.idsPresent], [true, true])
  assert.deepEqual(attributionFor(right), { status: 'EXACT_CAMPAIGN_AGGREGATED_VISITS', evidence: ['campaign_id_match'] })

  // extras missing altogether stays UNKNOWN as before
  assert.equal(build(sources({ metrika: { status: 'partial', data: { payload: metrikaPayload(), extras: null } } })).attribution.directToMetrika.status, 'UNKNOWN')
})

// ---- regression: Metrika names the autotargeting condition "Автотаргетинг" (id 11.0) ---------------------------------

test('autotargeting phrase: found by id 11.0 or by the exact Russian/English name; ordinary phrases are not', () => {
  assert.equal(isAutotargetingPhrase({ id: '11.0', name: 'Автотаргетинг' }), true) // production shape
  assert.equal(isAutotargetingPhrase({ id: '11.0', name: 'any localised name' }), true) // by id, whatever the name
  assert.equal(isAutotargetingPhrase({ id: null, name: 'Автотаргетинг' }), true)
  assert.equal(isAutotargetingPhrase({ id: null, name: ' автотаргетинг ' }), true) // normalised
  assert.equal(isAutotargetingPhrase({ id: null, name: 'Autotargeting' }), true)
  assert.equal(isAutotargetingPhrase({ id: '42.0', name: 'AUTOTARGETING' }), true)
  for (const value of [
    { id: '123456789.0', name: 'оклейка авто пленкой' },
    { id: null, name: 'автотаргетинг цена' }, // not a substring rule
    { id: '111.0', name: 'wb' },
    { id: '11', name: null },
    { id: null, name: null },
  ]) assert.equal(isAutotargetingPhrase(value), false, JSON.stringify(value))
})

test('breakdowns.autotargeting.metrika is filled from the production-shaped Metrika row', () => {
  const row = (id: string | null, name: string | null, visits: number) => ({ phraseOrCondition: { id, name }, visits, users: visits, bounceRate: 76.67, avgVisitDurationSeconds: 11.27, leadSubmitVisits: 0, leadSubmitReaches: 0 })
  const withRows = (rows: ReturnType<typeof row>[]) => {
    const payload = metrikaPayload()
    ;(payload.direct as unknown as { phrasesOrConditions: unknown[] }).phrasesOrConditions = rows
    return build(sources({ metrika: ok<MetrikaBundle>({ payload, extras: extras() }) })).breakdowns.autotargeting
  }
  const found = withRows([row('987654321.0', 'оклейка авто пленкой', 19), row('11.0', 'Автотаргетинг', 30)])
  assert.deepEqual(found.metrika, { visits: 30, bounceRate: 76.67, avgVisitDurationSeconds: 11.27, leadSubmitVisits: 0 })
  assert.deepEqual(found.direct, { impressions: 500, clicks: 30, spend: 1500, cpc: 50 }) // Direct side unchanged
  assert.equal(withRows([row(null, 'Autotargeting', 7)]).metrika!.visits, 7)
  assert.equal(withRows([row('987654321.0', 'оклейка авто пленкой', 19)]).metrika, null) // no autotargeting row → null, as before
})
