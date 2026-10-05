// Unified Analytics v0.1 — Direct + Metrika + CRM for ONE project and period, deterministic, read-only, aggregated.
// This module is the pure part: project config, the explicit test-traffic rule, CRM lead-signal aggregation, source
// collection (concurrent, failure-tolerant) and the response. Nothing here can carry personal data or a visitor
// identifier: the CRM input is the narrow `LeadSignal` (no name/phone/contact/ids), Metrika is aggregates only.
// No `@/` imports: runs under `node --test`.

import type { LeadSignal, LeadSignalsPayload, ObserverError } from './crm-observer.ts'
import type { ResolvedPeriod } from './observer-period.ts'
import type { ObserverPayload as DirectPayload } from './yandex-direct-report.ts'
import {
  matchesTestRules,
  normalizeMarker,
  type DailyGoalRow,
  type DirectSegment,
  type MetrikaPayload,
  type TestRules,
  type TestSegment,
  type UnifiedExtras,
  type Warning,
} from './yandex-metrika-report.ts'

// ---------------------------------------------------------------------------------------------
// Config (v0.1: constants, no DB, no config platform)
// ---------------------------------------------------------------------------------------------

/** Explicit, project-specific markers of known internal test traffic. Exact normalised string match, OR across fields. Never a substring/regex rule. */
export const TEST_TRAFFIC_RULES: Readonly<Record<string, TestRules>> = {
  driveset: { utmContent: ['a2_production_test'], utmTerm: ['test_attribution'] },
}

export type UnifiedProject = {
  /** Direct campaign id; must also be in YANDEX_DIRECT_CAMPAIGN_IDS. */
  campaignId: number
  crmSlug: string
  /** CRM Direct-attribution rule: utm_campaign equals the campaign id and utm_source is one of these (normalised). */
  directUtmSources: readonly string[]
  testRules: TestRules
}

export const UNIFIED_PROJECTS: Readonly<Record<string, UnifiedProject>> = {
  driveset: { campaignId: 714796268, crmSlug: 'driveset', directUtmSources: ['yandex', 'ya'], testRules: TEST_TRAFFIC_RULES.driveset },
}

export function resolveUnifiedProject(slug: string): UnifiedProject | null {
  return Object.prototype.hasOwnProperty.call(UNIFIED_PROJECTS, slug) ? UNIFIED_PROJECTS[slug] : null
}

/** Overall deadline for each external (HTTP) source. The CRM query is never aborted by it. */
export const SOURCE_DEADLINE_MS = 50_000
export const LOW_VOLUME_CLICKS = 100
export const LOW_VOLUME_LEADS = 5
const SEARCH_QUERY_LIMIT = 50

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

export type SourceStatus = 'ok' | 'partial' | 'unavailable'
export type SourceError = { kind: string; message: string }
export type SourceResult<T> = { status: SourceStatus; error?: SourceError; data: T | null }
export type MetrikaBundle = { payload: MetrikaPayload; extras: UnifiedExtras | null }

export type Loaders = {
  direct: () => Promise<DirectPayload>
  metrika: () => Promise<MetrikaBundle>
  crm: () => Promise<LeadSignalsPayload | ObserverError>
}
export type Sources = { direct: SourceResult<DirectPayload>; metrika: SourceResult<MetrikaBundle>; crm: SourceResult<LeadSignalsPayload> }

/** Only our own typed errors (they carry a `kind`) are described; anything else is a generic failure — never a raw message. */
function describeError(err: unknown): SourceError {
  if (err && typeof err === 'object' && 'kind' in err && typeof (err as { kind: unknown }).kind === 'string') {
    return { kind: (err as { kind: string }).kind, message: String((err as { message?: unknown }).message ?? '') }
  }
  return { kind: 'internal', message: 'unexpected failure' }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject({ kind: 'timeout', message: `no answer within ${Math.round(ms / 1000)} s` }), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

const metrikaIsPartial = (b: MetrikaBundle) =>
  b.extras === null ||
  b.extras.dailyGoals === null ||
  b.extras.directSegment === null ||
  b.extras.testSegment === null ||
  b.payload.warnings.some((w) => w.code === 'dimension_unavailable' || w.code === 'goal_missing')

/** The three sources run concurrently; one failing never fails another. Direct and Metrika are bounded by `deadlineMs`; the CRM query is awaited as is. */
export async function collectSources(loaders: Loaders, deadlineMs: number = SOURCE_DEADLINE_MS): Promise<Sources> {
  const [direct, metrika, crm] = await Promise.allSettled([withDeadline(loaders.direct(), deadlineMs), withDeadline(loaders.metrika(), deadlineMs), loaders.crm()])
  return {
    direct: direct.status === 'fulfilled' ? { status: 'ok', data: direct.value } : { status: 'unavailable', error: describeError(direct.reason), data: null },
    metrika:
      metrika.status === 'fulfilled'
        ? { status: metrikaIsPartial(metrika.value) ? 'partial' : 'ok', data: metrika.value }
        : { status: 'unavailable', error: describeError(metrika.reason), data: null },
    crm:
      crm.status === 'fulfilled'
        ? 'error' in crm.value
          ? { status: 'unavailable', error: { kind: crm.value.status === 404 ? 'project_not_found' : 'crm_error', message: crm.value.error }, data: null }
          : { status: crm.value.truncated ? 'partial' : 'ok', data: crm.value }
        : { status: 'unavailable', error: { kind: 'crm_error', message: 'CRM read failed' }, data: null },
  }
}

/** 200 if any source answered; 503 if every source is unavailable only because it is not configured; otherwise 502. */
export function unifiedHttpStatus(sources: Sources): number {
  const all = [sources.direct, sources.metrika, sources.crm]
  if (all.some((s) => s.status !== 'unavailable')) return 200
  return all.every((s) => s.error?.kind === 'not_configured') ? 503 : 502
}

// ---------------------------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------------------------

const round2 = (v: number) => Math.round(v * 100) / 100
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000
const moscowDate = (iso: string) => new Date(Date.parse(iso) + MOSCOW_OFFSET_MS).toISOString().slice(0, 10)

function eachDay(from: string, to: string): string[] {
  const days: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10))
  return days
}

export type Metric = { value: number | null; reason?: string }
const metric = (value: number | null, reason?: string): Metric => (value === null ? { value: null, reason: reason ?? 'unavailable' } : { value })

/** part / whole * 100. Each missing operand and a zero denominator get their own reason. */
function pct(part: number | null, whole: number | null, reasons: { part: string; whole: string; zero: string }): Metric {
  if (part === null) return { value: null, reason: reasons.part }
  if (whole === null) return { value: null, reason: reasons.whole }
  if (whole === 0) return { value: null, reason: reasons.zero }
  return { value: round2((part / whole) * 100) }
}

// ---------------------------------------------------------------------------------------------
// CRM aggregation (signals only)
// ---------------------------------------------------------------------------------------------

export type CrmSummary = {
  status: SourceStatus
  error?: SourceError
  leads: number | null
  testLeads: number | null
  leadsDirect: number | null
  leadsUnattributed: number | null
  byStatus: Record<string, number> | null
  truncated: boolean
  /** non-test leads per Moscow day (internal; used for daily[]). */
  perDay: Map<string, number> | null
}

export const isTestSignal = (rules: TestRules, s: Pick<LeadSignal, 'utmContent' | 'utmTerm'>) => matchesTestRules(rules, s.utmContent, s.utmTerm)

/** Direct attribution at CRM level: not a known test, utm_campaign == the campaign id and utm_source in the Direct sources. AGGREGATED, not proof of a click. */
export function isDirectLead(project: UnifiedProject, s: LeadSignal): boolean {
  return !isTestSignal(project.testRules, s) && s.utmCampaign.trim() === String(project.campaignId) && project.directUtmSources.includes(normalizeMarker(s.utmSource))
}

export function summarizeCrm(source: SourceResult<LeadSignalsPayload>, project: UnifiedProject): CrmSummary {
  if (!source.data) return { status: source.status, error: source.error, leads: null, testLeads: null, leadsDirect: null, leadsUnattributed: null, byStatus: null, truncated: false, perDay: null }
  const signals = source.data.signals
  const byStatus: Record<string, number> = {}
  const perDay = new Map<string, number>()
  let testLeads = 0
  let leadsDirect = 0
  let nonTest = 0
  for (const s of signals) {
    if (isTestSignal(project.testRules, s)) {
      testLeads++
      continue
    }
    nonTest++
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1
    const day = moscowDate(s.createdAt)
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
    if (isDirectLead(project, s)) leadsDirect++
  }
  return { status: source.status, leads: source.data.total, testLeads, leadsDirect, leadsUnattributed: nonTest - leadsDirect, byStatus, truncated: source.data.truncated, perDay }
}

// ---------------------------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------------------------

export const LIMITATIONS = [
  'Direct → Metrika: the campaign is matched EXACTLY by id (lastDirectClickOrder.id); clicks and visits are different populations, so their ratio is AGGREGATED.',
  'Metrika → CRM: AGGREGATED. CRM Direct leads are matched by landing UTM (utm_campaign + utm_source), which is the site\'s first-touch value; Metrika attributes by last significant source. A UTM match is not proof of a Direct click.',
  'The funnel is visits that reached each goal, not a proven same-visit sequence.',
  'No query-level or phrase-level CPL: the CRM does not store the search query.',
  'Direct spend and CPC include VAT (RUB). Direct current-day numbers are partial and lag.',
  'Known test traffic is excluded only by the explicit project markers (exact utm_content / utm_term values); other internal traffic is not detected.',
  'No personal data, ClientID, yclid or lead_tracking_id is requested or returned.',
] as const

type Goals = Record<string, { visits: number | null; reaches: number | null }>

function allTrafficGoals(m: MetrikaPayload | null): Goals | null {
  if (!m) return null
  return Object.fromEntries(m.goals.map((g) => [g.event, { visits: g.found ? g.visitsWithGoal : null, reaches: g.found ? g.reaches : null }]))
}

const minus = (a: number | null, b: number | undefined) => (a === null || b === undefined ? null : Math.max(0, a - b))

export function buildUnifiedPayload(input: { project: string; config: UnifiedProject; period: ResolvedPeriod; now: Date; sources: Sources }) {
  const { config, period, sources } = input
  const warnings: (Warning & { source?: string })[] = []
  const warn = (code: string, message: string, source?: string) => warnings.push(source ? { code, message, source } : { code, message })

  const dPayload = sources.direct.data
  const mBundle = sources.metrika.data
  const mPayload = mBundle?.payload ?? null
  const extras = mBundle?.extras ?? null
  const crm = summarizeCrm(sources.crm, config)

  if (!period.complete) warn('incomplete_period', 'The period includes the current day, which is not finished: Direct and Metrika numbers are partial and CPL is not calculated.')
  for (const [name, s] of Object.entries(sources)) {
    if (s.status === 'unavailable') warn('source_unavailable', `${name} is unavailable (${s.error?.kind ?? 'unknown'}); dependent metrics are null.`, name)
    if (s.status === 'partial') warn('source_partial', `${name} answered partially.`, name)
  }
  if (crm.truncated) warn('crm_truncated', 'More leads matched than were read; CRM counts are incomplete and CPL is not calculated.', 'crm')
  if (mPayload) for (const w of mPayload.warnings) if (w.code !== 'incomplete_period') warn(w.code, w.message, 'metrika')
  if (extras) for (const w of extras.warnings) warn(w.code, w.message, 'metrika')
  if ((mPayload?.meta.sampled ?? false) || (extras?.sampled ?? false)) warn('sampled', 'Some Metrika queries were sampled: Metrika numbers are estimates.', 'metrika')
  if (extras?.directSegment && !extras.directSegment.idsPresent) warn('direct_campaign_id_missing', 'Metrika returned Direct campaign rows without ids: the exact id match is impossible.', 'metrika')
  warn('funnel_not_strict', 'The funnel counts visits that reached each goal; it is not a proven same-visit sequence.')

  // --- direct
  const dTotals = dPayload?.campaign.totals ?? null
  const direct = {
    status: sources.direct.status,
    ...(sources.direct.error ? { error: sources.direct.error } : {}),
    complete: period.complete,
    campaign: { id: config.campaignId, name: dPayload?.campaign.name ?? null },
    impressions: dTotals?.impressions ?? null,
    clicks: dTotals?.clicks ?? null,
    spend: dTotals?.spend ?? null,
    ctr: dTotals ? (dTotals.impressions > 0 ? round2((dTotals.clicks / dTotals.impressions) * 100) : null) : null,
    cpc: dTotals?.cpc ?? null,
    includesVat: true as const,
  }

  // --- metrika
  const test: TestSegment | null = extras?.testSegment ?? null
  const segment: DirectSegment | null = extras?.directSegment ?? null
  const totalGoals = allTrafficGoals(mPayload)
  const visits = mPayload?.totals.visits ?? null
  const metrika = {
    status: sources.metrika.status,
    ...(sources.metrika.error ? { error: sources.metrika.error } : {}),
    visits,
    users: mPayload?.totals.users ?? null,
    bounceRate: mPayload?.totals.bounceRate ?? null,
    avgVisitDurationSeconds: mPayload?.totals.avgVisitDurationSeconds ?? null,
    sampled: mPayload ? (mPayload.meta.sampled || (extras?.sampled ?? false)) : null,
    directClickVisits: segment ? segment.visits : null,
    excludingTest: {
      visits: minus(visits, test?.visits),
      leadSubmitVisits: minus(totalGoals?.lead_submit?.visits ?? null, test?.goalVisits.lead_submit),
    },
  }

  // --- funnel (all visits raw; excludingTest subtracts the known test segment; direct-click segment)
  const funnelOf = (g: Goals | null, subtractTest: boolean) => {
    const pick = (event: string, key: 'visits' | 'reaches'): number | null => {
      const raw = g?.[event]?.[key] ?? null
      if (!subtractTest) return raw
      const t = key === 'visits' ? test?.goalVisits[event] : event === 'lead_submit' ? test?.leadSubmitReaches : undefined
      return minus(raw, t)
    }
    return {
      quizStartVisits: pick('quiz_start', 'visits'),
      carSelectedVisits: pick('car_selected', 'visits'),
      packageSelectedVisits: pick('package_selected', 'visits'),
      quizPhoneVisits: pick('quiz_phone', 'visits'),
      leadSubmitVisits: pick('lead_submit', 'visits'),
      leadSubmitReaches: pick('lead_submit', 'reaches'),
    }
  }
  const segmentGoals: Goals | null = segment ? (segment.goals as Goals) : null
  const funnelRaw = funnelOf(totalGoals, false)
  const funnelClean = test ? funnelOf(totalGoals, true) : null
  const funnel = {
    scope: 'all_visits' as const,
    ...funnelRaw,
    excludingTest: funnelClean,
    direct: { scope: 'direct_click' as const, ...funnelOf(segmentGoals, false) },
  }

  const intent = (g: Goals | null) => ({ telegram: g?.telegram_click?.visits ?? null, max: g?.max_click?.visits ?? null, phone: g?.phone_click?.visits ?? null })
  const contactIntentVisits = { ...intent(totalGoals), direct: intent(segmentGoals) }

  // --- conversions
  const base = funnelClean ?? funnelRaw
  const baseVisits = metrika.excludingTest.visits ?? visits
  const clicks = direct.clicks
  const unavailable = (s: SourceStatus) => s === 'unavailable'
  const dReason = unavailable(sources.direct.status) ? 'direct_unavailable' : 'no_data'
  const mReason = unavailable(sources.metrika.status) ? 'metrika_unavailable' : 'no_data'
  const cReason = unavailable(sources.crm.status) ? 'crm_unavailable' : 'no_data'
  const segReason = unavailable(sources.metrika.status) ? 'metrika_unavailable' : 'direct_segment_unavailable'

  let cpl: Metric & { attributionConfidence?: 'AGGREGATED' }
  if (!period.complete) cpl = { value: null, reason: 'period_incomplete' }
  else if (sources.direct.status !== 'ok') cpl = { value: null, reason: 'direct_unavailable' }
  else if (sources.crm.status === 'unavailable') cpl = { value: null, reason: 'crm_unavailable' }
  else if (!(direct.spend !== null && direct.spend > 0)) cpl = { value: null, reason: 'no_spend' }
  else if (crm.truncated) cpl = { value: null, reason: 'crm_truncated' }
  else if (!crm.leadsDirect || crm.leadsDirect < 1) cpl = { value: null, reason: 'no_attributed_leads' }
  else cpl = { value: round2(direct.spend / crm.leadsDirect), attributionConfidence: 'AGGREGATED' }

  const conversions = {
    basis: test ? ('excluding_test' as const) : ('raw' as const),
    clickToVisitPct: clicks === null ? metric(null, dReason) : pct(metrika.directClickVisits, clicks, { part: segReason, whole: dReason, zero: 'no_clicks' }),
    visitToQuizPct: pct(base.quizStartVisits, baseVisits, { part: mReason, whole: mReason, zero: 'no_visits' }),
    quizToContactPct: pct(base.quizPhoneVisits, base.quizStartVisits, { part: mReason, whole: mReason, zero: 'no_quiz_starts' }),
    visitToMetrikaLeadPct: pct(base.leadSubmitVisits, baseVisits, { part: mReason, whole: mReason, zero: 'no_visits' }),
    visitToCrmLeadPct: pct(crm.leadsDirect, metrika.directClickVisits, { part: cReason, whole: segReason, zero: 'no_direct_visits' }),
    clickToCrmLeadPct: pct(crm.leadsDirect, clicks, { part: cReason, whole: dReason, zero: 'no_clicks' }),
    cpl,
  }

  if ((clicks !== null && clicks < LOW_VOLUME_CLICKS) || (crm.leadsDirect !== null && crm.leadsDirect < LOW_VOLUME_LEADS)) {
    warn('low_volume', `Low volume (clicks ${clicks ?? 'n/a'} < ${LOW_VOLUME_CLICKS} or Direct CRM leads ${crm.leadsDirect ?? 'n/a'} < ${LOW_VOLUME_LEADS}): percentages are noisy. Calculations are not blocked.`)
  }

  // --- daily (merged by Moscow day; each source's columns are null when that source is unavailable)
  const directDaily = new Map((dPayload?.daily ?? []).map((d) => [d.date, d]))
  const metrikaDaily = new Map((mPayload?.daily ?? []).map((d) => [d.date, d]))
  const goalDaily = new Map((extras?.dailyGoals ?? ([] as DailyGoalRow[])).map((d) => [d.date, d]))
  const daily = eachDay(period.from, period.to).map((date) => {
    const d = directDaily.get(date)
    const g = goalDaily.get(date)
    return {
      date,
      impressions: dPayload ? (d?.impressions ?? 0) : null,
      clicks: dPayload ? (d?.clicks ?? 0) : null,
      spend: dPayload ? (d?.spend ?? 0) : null,
      visits: mPayload ? (metrikaDaily.get(date)?.visits ?? 0) : null,
      quizStartVisits: extras?.dailyGoals ? (g?.quizStartVisits ?? 0) : null,
      leadSubmitVisits: extras?.dailyGoals ? (g?.leadSubmitVisits ?? 0) : null,
      crmLeads: crm.perDay ? (crm.perDay.get(date) ?? 0) : null,
    }
  })

  // --- breakdowns
  const auto = (dPayload?.searchQueries ?? []).filter((q) => q.criteriaType === 'AUTOTARGETING')
  const autoDirect = dPayload
    ? (() => {
        const impressions = auto.reduce((s, q) => s + q.impressions, 0)
        const c = auto.reduce((s, q) => s + q.clicks, 0)
        const spend = Math.round(auto.reduce((s, q) => s + q.spend, 0) * 10_000) / 10_000
        return { impressions, clicks: c, spend, cpc: c > 0 ? round2(spend / c) : null }
      })()
    : null
  const phraseRow = mPayload?.direct.phrasesOrConditions.find((r) => normalizeMarker(r.phraseOrCondition.name) === 'autotargeting')
  const metrikaPhrase = (r: { visits: number | null; bounceRate: number | null; avgVisitDurationSeconds: number | null; leadSubmitVisits: number | null }) => ({
    visits: r.visits,
    bounceRate: r.bounceRate,
    avgVisitDurationSeconds: r.avgVisitDurationSeconds,
    leadSubmitVisits: r.leadSubmitVisits,
  })

  const phraseByText = new Map((mPayload?.direct.searchPhrases ?? []).map((r) => [normalizeMarker(r.searchPhrase.name), r]))
  const grouped = new Map<string, { query: string; impressions: number; clicks: number; spend: number; criteriaTypes: Set<string> }>()
  for (const q of dPayload?.searchQueries ?? []) {
    const key = normalizeMarker(q.query)
    const row = grouped.get(key) ?? { query: q.query, impressions: 0, clicks: 0, spend: 0, criteriaTypes: new Set<string>() }
    row.impressions += q.impressions
    row.clicks += q.clicks
    row.spend += q.spend
    row.criteriaTypes.add(q.criteriaType)
    grouped.set(key, row)
  }
  const queryRows = [...grouped.entries()]
    .sort((a, b) => b[1].spend - a[1].spend || b[1].clicks - a[1].clicks || a[1].query.localeCompare(b[1].query))
    .slice(0, SEARCH_QUERY_LIMIT)
    .map(([key, r]) => {
      const spend = Math.round(r.spend * 10_000) / 10_000
      const m = phraseByText.get(key)
      return {
        query: r.query,
        criteriaTypes: [...r.criteriaTypes].sort(),
        impressions: r.impressions,
        clicks: r.clicks,
        spend,
        cpc: r.clicks > 0 ? round2(spend / r.clicks) : null,
        metrika: m ? metrikaPhrase(m) : null,
      }
    })

  const breakdowns = {
    campaign: {
      confidence: 'EXACT' as const,
      note: 'Direct campaign id equals Metrika lastDirectClickOrder.id.',
      rows: [
        {
          campaign: { id: config.campaignId, name: direct.campaign.name },
          direct: dTotals ? { impressions: dTotals.impressions, clicks: dTotals.clicks, spend: dTotals.spend, cpc: dTotals.cpc } : null,
          metrika: segment ? { visits: segment.visits, ...funnelOf(segmentGoals, false) } : null,
        },
      ],
    },
    autotargeting: {
      confidence: 'AGGREGATED' as const,
      sources: { direct: 'EXACT', metrika: 'AGGREGATED', crm: 'NOT_SAFE' },
      direct: autoDirect,
      metrika: phraseRow ? metrikaPhrase(phraseRow) : null,
      crm: { confidence: 'NOT_SAFE' as const, reason: 'not_query_level_and_too_few_leads' },
    },
    searchQueries: {
      confidence: 'AGGREGATED' as const,
      sources: { direct: 'EXACT', metrika: 'AGGREGATED', crm: 'NOT_SAFE' },
      note: 'Direct numbers are exact per query; Metrika visits are joined by normalised phrase text (AGGREGATED); CRM leads and CPL are not available per query.',
      truncated: grouped.size > SEARCH_QUERY_LIMIT,
      rows: queryRows,
    },
    daily: { confidence: 'AGGREGATED' as const, ref: 'daily' },
  }

  // --- attribution
  const exactCampaign = segment !== null && segment.idsPresent
  const attribution = {
    directToMetrika: exactCampaign
      ? { status: 'EXACT_CAMPAIGN_AGGREGATED_VISITS', evidence: ['campaign_id_match'] }
      : { status: 'UNKNOWN', evidence: [] as string[], reason: sources.metrika.status === 'unavailable' ? 'metrika_unavailable' : 'direct_segment_unavailable' },
    metrikaToCrm: { status: 'AGGREGATED', evidence: ['utm_campaign_and_source_match'], note: 'First-touch UTM in the CRM vs last-significant-source in Metrika; no per-visit link.' },
    overall: { status: sources.direct.status !== 'unavailable' && sources.metrika.status !== 'unavailable' && sources.crm.status !== 'unavailable' ? 'AGGREGATED' : 'UNKNOWN' },
    notes: [...LIMITATIONS],
  }

  const testTraffic = {
    detected: (test?.visits ?? 0) > 0 || (crm.testLeads ?? 0) > 0,
    metrikaVisits: test ? test.visits : null,
    metrikaLeadSubmitVisits: test ? (test.goalVisits.lead_submit ?? 0) : null,
    crmLeads: crm.testLeads,
    rulesApplied: { utmContent: [...config.testRules.utmContent], utmTerm: [...config.testRules.utmTerm], match: 'exact_normalized_or' },
  }

  return {
    project: input.project,
    period: { from: period.from, to: period.to, timezone: period.timezone, complete: period.complete, preset: period.preset },
    direct,
    metrika,
    crm: {
      status: crm.status,
      ...(crm.error ? { error: crm.error } : {}),
      leads: crm.leads,
      testLeads: crm.testLeads,
      leadsDirect: crm.leadsDirect,
      leadsUnattributed: crm.leadsUnattributed,
      byStatus: crm.byStatus,
      truncated: crm.truncated,
    },
    funnel,
    contactIntentVisits,
    conversions,
    daily,
    breakdowns,
    attribution,
    testTraffic,
    warnings,
    meta: {
      sources: {
        direct: { status: sources.direct.status, ...(sources.direct.error ? { error: sources.direct.error } : {}) },
        metrika: { status: sources.metrika.status, ...(sources.metrika.error ? { error: sources.metrika.error } : {}) },
        crm: { status: sources.crm.status, ...(sources.crm.error ? { error: sources.crm.error } : {}) },
      },
      sampled: metrika.sampled,
      generatedAt: input.now.toISOString(),
      sourceDeadlineSeconds: SOURCE_DEADLINE_MS / 1000,
      limitations: [...LIMITATIONS],
    },
  }
}

export type UnifiedPayload = ReturnType<typeof buildUnifiedPayload>
