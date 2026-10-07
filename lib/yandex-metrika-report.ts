// Metrika Observer v0.1 — pure part: query definitions, response parsing and the response payload.
// READ-ONLY, aggregated only. Nothing here asks for (or can return) a visitor identifier: ClientID, yclid and any
// user-level dimension are not in the allowed dimension list. No `@/` imports: runs under `node --test`.

import type { ResolvedPeriod } from './observer-period.ts'

// ---------------------------------------------------------------------------------------------
// Goals (real goals of counter 113053562; condition = exact JS event name). polirovka_* / himchistka_* have no goals.
// ---------------------------------------------------------------------------------------------

export type GoalSpec = { id: number; name: string; event: string }

export const FUNNEL_EVENTS = ['quiz_start', 'car_selected', 'package_selected', 'quiz_phone', 'lead_submit'] as const

export const OBSERVED_GOALS: readonly GoalSpec[] = [
  { id: 664270022, name: 'Quiz — начало', event: 'quiz_start' },
  { id: 664390829, name: 'Quiz — автомобиль выбран', event: 'car_selected' },
  { id: 664390675, name: 'Quiz — пакет выбран', event: 'package_selected' },
  { id: 664270271, name: 'Quiz — телефон', event: 'quiz_phone' },
  { id: 663848261, name: 'Заявка — отправка формы', event: 'lead_submit' },
  { id: 668423464, name: 'Telegram — клик', event: 'telegram_click' },
  { id: 668423668, name: 'MAX — клик', event: 'max_click' },
  { id: 668423711, name: 'Телефон — клик', event: 'phone_click' },
]

const LEAD_GOAL = OBSERVED_GOALS.find((g) => g.event === 'lead_submit') as GoalSpec

// ---------------------------------------------------------------------------------------------
// Allowed Reporting API names (the client refuses anything else)
// ---------------------------------------------------------------------------------------------

export const DIM = {
  date: 'ym:s:date',
  trafficSource: 'ym:s:lastsignTrafficSource',
  utmSource: 'ym:s:lastsignUTMSource',
  utmMedium: 'ym:s:lastsignUTMMedium',
  utmCampaign: 'ym:s:lastsignUTMCampaign',
  utmContent: 'ym:s:lastsignUTMContent',
  utmTerm: 'ym:s:lastsignUTMTerm',
  directCampaign: 'ym:s:lastDirectClickOrder',
  directBanner: 'ym:s:lastDirectClickBanner',
  directPhraseOrCond: 'ym:s:lastDirectPhraseOrCond',
  directSearchPhrase: 'ym:s:lastDirectSearchPhrase',
  /** SEO Observer: the landing page path of the visit (verified on the counter, see ORGANIC_FILTER). */
  startUrlPath: 'ym:s:startURLPath',
} as const

export const ALLOWED_DIMENSIONS: readonly string[] = Object.values(DIM)
/** Visit metrics and per-goal metrics only. */
export const ALLOWED_METRIC_RE = /^ym:s:(visits|users|bounceRate|avgVisitDurationSeconds|goal\d+(reaches|visits))$/

export type StatQuery = { dimensions: string[]; metrics: string[]; sort?: string; limit: number; filters?: string }

export const BASE_METRICS = ['ym:s:visits', 'ym:s:users', 'ym:s:bounceRate', 'ym:s:avgVisitDurationSeconds'] as const
const goalMetrics = (id: number) => [`ym:s:goal${id}reaches`, `ym:s:goal${id}visits`]

export const BREAKDOWN_LIMIT = 100
const MAX_DAYS = 92

export function dailyQuery(): StatQuery {
  return { dimensions: [DIM.date], metrics: [...BASE_METRICS], sort: DIM.date, limit: MAX_DAYS + 8 }
}

/** Totals only (no dimension): one row, all observed goals — reaches and visits with the goal side by side. */
export function goalsQuery(goals: readonly GoalSpec[]): StatQuery {
  return { dimensions: [], metrics: goals.flatMap((g) => goalMetrics(g.id)), limit: 1 }
}

/** Breakdown with the base metrics plus the lead goal (so a conversion can be read per row). */
export function breakdownQuery(dimensions: string[], withLeadGoal: boolean): StatQuery {
  return {
    dimensions,
    metrics: [...BASE_METRICS, ...(withLeadGoal ? goalMetrics(LEAD_GOAL.id) : [])],
    sort: '-ym:s:visits',
    limit: BREAKDOWN_LIMIT,
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export class ReportFormatError extends Error {}

export type DimensionValue = { id: string | null; name: string | null }
export type StatRow = { dimensions: DimensionValue[]; metrics: (number | null)[] }
export type StatResponse = {
  rows: StatRow[]
  totals: (number | null)[]
  totalRows: number | null
  sampled: boolean
  sampleShare: number | null
  dataLagSeconds: number | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const round = (v: number | null, digits = 2): number | null => (v === null ? null : Number(v.toFixed(digits)))

export function parseStatResponse(json: unknown): StatResponse {
  if (!json || typeof json !== 'object') throw new ReportFormatError('Metrika returned an unreadable report')
  const body = json as Record<string, unknown>
  if (!Array.isArray(body.data)) throw new ReportFormatError('Metrika report has no data array')
  const rows: StatRow[] = body.data.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>
    const dims = Array.isArray(row.dimensions) ? row.dimensions : []
    const metrics = Array.isArray(row.metrics) ? row.metrics : []
    return {
      dimensions: dims.map((d) => {
        const o = (d ?? {}) as Record<string, unknown>
        return { id: o.id === undefined || o.id === null ? null : String(o.id), name: str(o.name) }
      }),
      metrics: metrics.map(num),
    }
  })
  return {
    rows,
    totals: Array.isArray(body.totals) ? body.totals.map(num) : [],
    totalRows: num(body.total_rows),
    sampled: body.sampled === true,
    sampleShare: num(body.sample_share),
    dataLagSeconds: num(body.data_lag),
  }
}

// ---------------------------------------------------------------------------------------------
// Goal list check (Management API: id, name, type, conditions — names and conditions only)
// ---------------------------------------------------------------------------------------------

export type Warning = { code: string; message: string }

export type ManagedGoal = { id: number; name: string | null; type: string | null; events: string[] }

export function parseManagedGoals(json: unknown): ManagedGoal[] {
  const list = json && typeof json === 'object' ? (json as { goals?: unknown }).goals : null
  if (!Array.isArray(list)) throw new ReportFormatError('Metrika goal list is unreadable')
  return list.flatMap((raw) => {
    const g = (raw ?? {}) as Record<string, unknown>
    const id = num(g.id)
    if (id === null) return []
    const conditions = Array.isArray(g.conditions) ? g.conditions : []
    return [
      {
        id,
        name: str(g.name),
        type: str(g.type),
        events: conditions.flatMap((c) => {
          const o = (c ?? {}) as Record<string, unknown>
          return o.type === 'exact' && typeof o.url === 'string' ? [o.url] : []
        }),
      },
    ]
  })
}

export type GoalCheck = { present: GoalSpec[]; missing: GoalSpec[]; warnings: Warning[] }

/** managed = null: the goal list could not be read → assume present and say so. */
export function checkGoals(managed: ManagedGoal[] | null): GoalCheck {
  if (managed === null) {
    return {
      present: [...OBSERVED_GOALS],
      missing: [],
      warnings: [{ code: 'goal_list_unavailable', message: 'The counter goal list could not be read; goals are assumed to exist.' }],
    }
  }
  const present: GoalSpec[] = []
  const missing: GoalSpec[] = []
  const warnings: Warning[] = []
  for (const goal of OBSERVED_GOALS) {
    const found = managed.find((m) => m.id === goal.id)
    if (!found) {
      missing.push(goal)
      warnings.push({ code: 'goal_missing', message: `Goal ${goal.id} (${goal.event}) does not exist in the counter.` })
      continue
    }
    present.push(goal)
    if (!found.events.includes(goal.event)) {
      warnings.push({ code: 'goal_condition_mismatch', message: `Goal ${goal.id} no longer has the exact condition "${goal.event}".` })
    }
  }
  return { present, missing, warnings }
}

// ---------------------------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------------------------

export type Totals = { visits: number | null; users: number | null; bounceRate: number | null; avgVisitDurationSeconds: number | null }
export type DailyRow = Totals & { date: string }
export type GoalRow = { id: number; name: string; event: string; found: boolean; reaches: number | null; visitsWithGoal: number | null }
export type FunnelStep = {
  step: string
  event: string | null
  /** Visits that reached the step (for `visit`: all visits). */
  visits: number | null
  /** Diagnostic only: goal reaches can exceed visits (a goal may fire several times per visit). */
  reaches: number | null
  conversionFromPreviousPct: number | null
  conversionFromVisitsPct: number | null
}
export type BreakdownRow = Totals & { leadSubmitVisits: number | null; leadSubmitReaches: number | null }
export type DirectValue = { id: string | null; name: string | null }

const baseTotals = (m: (number | null)[]): Totals => ({
  visits: m[0] ?? null,
  users: m[1] ?? null,
  bounceRate: round(m[2] ?? null),
  avgVisitDurationSeconds: round(m[3] ?? null),
})

function breakdownRow(row: StatRow, withLeadGoal: boolean): BreakdownRow {
  return {
    ...baseTotals(row.metrics),
    leadSubmitReaches: withLeadGoal ? (row.metrics[4] ?? null) : null,
    leadSubmitVisits: withLeadGoal ? (row.metrics[5] ?? null) : null,
  }
}

export type BreakdownInput = { response: StatResponse | null; failed?: string }

export type PayloadInput = {
  project: string
  counter: { id: number; timezone: string }
  period: ResolvedPeriod
  now: Date
  goalCheck: GoalCheck
  daily: StatResponse
  goals: StatResponse | null
  sources: BreakdownInput
  utm: BreakdownInput
  directCampaigns: BreakdownInput
  directBanners: BreakdownInput
  directPhrasesOrConditions: BreakdownInput
  directSearchPhrases: BreakdownInput
  requests: number
}

export const LIMITATIONS = [
  'Direct → Metrika: AGGREGATED (by campaign, ad, phrase/condition, UTM) — not per click.',
  'Metrika → CRM: not linked by this endpoint; a separate layer is not implemented yet.',
  'A Direct search phrase is not tied to a CRM lead.',
  'No visitor-level identifiers or user data are requested or returned.',
  'lead_tracking_id is not a Metrika visit id.',
  'Funnel steps are visits that reached each goal, not a strict sequence.',
] as const

function eachDay(from: string, to: string): string[] {
  const days: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10))
  return days
}

export function buildMetrikaPayload(input: PayloadInput) {
  const warnings: Warning[] = [...input.goalCheck.warnings]
  const withLead = input.goalCheck.present.some((g) => g.id === LEAD_GOAL.id)

  if (!input.period.complete) {
    warnings.push({ code: 'incomplete_period', message: 'The period includes the current day, which is not finished: numbers are partial and may still change.' })
  }

  // --- totals + daily (days without visits are absent in Metrika's answer → filled with zeros)
  const totals = baseTotals(input.daily.totals)
  const byDate = new Map(input.daily.rows.map((r) => [r.dimensions[0]?.name ?? '', r]))
  const daily: DailyRow[] = eachDay(input.period.from, input.period.to).map((date) => {
    const row = byDate.get(date)
    return row ? { date, ...baseTotals(row.metrics) } : { date, visits: 0, users: 0, bounceRate: null, avgVisitDurationSeconds: null }
  })

  // --- goals: reaches and visitsWithGoal side by side
  const metricByName = new Map<string, number | null>()
  if (input.goals) {
    const names = goalsQuery(input.goalCheck.present).metrics
    const source = input.goals.rows[0]?.metrics ?? input.goals.totals
    names.forEach((name, i) => metricByName.set(name, source[i] ?? null))
  }
  const goals: GoalRow[] = OBSERVED_GOALS.map((g) => {
    const found = input.goalCheck.present.includes(g)
    return {
      id: g.id,
      name: g.name,
      event: g.event,
      found,
      reaches: found ? (metricByName.get(`ym:s:goal${g.id}reaches`) ?? null) : null,
      visitsWithGoal: found ? (metricByName.get(`ym:s:goal${g.id}visits`) ?? null) : null,
    }
  })

  // --- funnel by visitsWithGoal (reaches only as a diagnostic)
  const funnel: FunnelStep[] = [
    { step: 'visit', event: null, visits: totals.visits, reaches: null, conversionFromPreviousPct: null, conversionFromVisitsPct: totals.visits === null ? null : 100 },
  ]
  const pct = (part: number | null, whole: number | null) => (part === null || whole === null || whole === 0 ? null : round((part / whole) * 100))
  let previous = totals.visits
  let nonMonotonic = false
  for (const event of FUNNEL_EVENTS) {
    const goal = goals.find((g) => g.event === event) as GoalRow
    funnel.push({
      step: event,
      event,
      visits: goal.visitsWithGoal,
      reaches: goal.reaches,
      conversionFromPreviousPct: pct(goal.visitsWithGoal, previous),
      conversionFromVisitsPct: pct(goal.visitsWithGoal, totals.visits),
    })
    if (goal.visitsWithGoal !== null && previous !== null && goal.visitsWithGoal > previous) nonMonotonic = true
    if (goal.visitsWithGoal !== null) previous = goal.visitsWithGoal
  }
  if (nonMonotonic) {
    warnings.push({ code: 'funnel_not_monotonic', message: 'A later funnel step has more visits than the previous one: the goals are not a strict sequence.' })
  }

  // --- breakdowns (a rejected dimension becomes a warning and an empty list, never a 500)
  const sampledQueries: StatResponse[] = [input.daily]
  if (input.goals) sampledQueries.push(input.goals)
  const rowsOf = (block: string, b: BreakdownInput): StatRow[] => {
    if (b.failed) {
      warnings.push({ code: 'dimension_unavailable', message: `${block}: Metrika rejected this breakdown (${b.failed}).` })
      return []
    }
    if (!b.response) return []
    sampledQueries.push(b.response)
    if (b.response.totalRows !== null && b.response.totalRows > b.response.rows.length) {
      warnings.push({ code: 'rows_truncated', message: `${block}: ${b.response.rows.length} of ${b.response.totalRows} rows returned.` })
    }
    return b.response.rows
  }
  const dim = (row: StatRow, i: number): DimensionValue => row.dimensions[i] ?? { id: null, name: null }
  const name = (row: StatRow, i: number) => dim(row, i).name

  const sources = rowsOf('sources', input.sources).map((r) => ({ source: name(r, 0), ...breakdownRow(r, withLead) }))
  const utm = rowsOf('utm', input.utm).map((r) => ({
    source: name(r, 0),
    medium: name(r, 1),
    campaign: name(r, 2),
    content: name(r, 3),
    term: name(r, 4),
    ...breakdownRow(r, withLead),
  }))
  const direct = {
    campaigns: rowsOf('direct.campaigns', input.directCampaigns).map((r) => ({ campaign: dim(r, 0), ...breakdownRow(r, withLead) })),
    banners: rowsOf('direct.banners', input.directBanners).map((r) => ({ banner: dim(r, 0), ...breakdownRow(r, withLead) })),
    phrasesOrConditions: rowsOf('direct.phrasesOrConditions', input.directPhrasesOrConditions).map((r) => ({
      phraseOrCondition: dim(r, 0),
      ...breakdownRow(r, withLead),
    })),
    searchPhrases: rowsOf('direct.searchPhrases', input.directSearchPhrases).map((r) => ({ searchPhrase: dim(r, 0), ...breakdownRow(r, withLead) })),
  }
  if (!input.directSearchPhrases.failed && direct.searchPhrases.length === 0) {
    warnings.push({ code: 'search_phrase_no_data', message: 'Metrika returned no Direct search phrases for this period.' })
  }

  // --- sampling
  const sampledCount = sampledQueries.filter((q) => q.sampled).length
  const shares = sampledQueries.flatMap((q) => (q.sampled && q.sampleShare !== null ? [q.sampleShare] : []))
  if (sampledCount > 0) {
    warnings.push({ code: 'sampled', message: `${sampledCount} of ${sampledQueries.length} Metrika queries were sampled: numbers are estimates.` })
  }
  const lags = sampledQueries.flatMap((q) => (q.dataLagSeconds === null ? [] : [q.dataLagSeconds]))

  return {
    project: input.project,
    period: { from: input.period.from, to: input.period.to, timezone: input.period.timezone, complete: input.period.complete, preset: input.period.preset },
    counter: { id: input.counter.id, timezone: input.counter.timezone },
    totals,
    daily,
    goals,
    funnel,
    sources,
    utm,
    direct,
    warnings,
    meta: {
      sampled: sampledCount > 0,
      sampling: { sampledQueries: sampledCount, totalQueries: sampledQueries.length, minSampleShare: shares.length ? Math.min(...shares) : null },
      dataLagSeconds: lags.length ? Math.max(...lags) : null,
      attributionModel: { sources: 'lastsign', utm: 'lastsign', direct: 'lastDirectClick' },
      requests: input.requests,
      generatedAt: input.now.toISOString(),
      limitations: [...LIMITATIONS],
    },
  }
}

export type MetrikaPayload = ReturnType<typeof buildMetrikaPayload>

// ---------------------------------------------------------------------------------------------
// Unified Analytics extras (read-only, aggregated): per-day goal visits, the Direct-click segment of the funnel and
// the explicit test-traffic segment. Same allow-listed dimensions/metrics as everything above.
// ---------------------------------------------------------------------------------------------

export const CONTACT_EVENTS = ['telegram_click', 'max_click', 'phone_click'] as const
/** Goals read for the Direct-click segment: the funnel plus the three contact intents. */
export const SEGMENT_EVENTS = [...FUNNEL_EVENTS, ...CONTACT_EVENTS] as const

const goalOf = (event: string): GoalSpec => OBSERVED_GOALS.find((g) => g.event === event) as GoalSpec
const visitsMetric = (event: string) => `ym:s:goal${goalOf(event).id}visits`
const reachesMetric = (event: string) => `ym:s:goal${goalOf(event).id}reaches`

export type TestRules = {
  utmContent: readonly string[]
  utmTerm: readonly string[]
  /** (utm_source AND utm_medium) pairs that mark test traffic, e.g. olnoo + test. */
  utmPairs?: readonly { readonly source: string; readonly medium: string }[]
}

/** Exact, normalised string comparison — never a substring/regex match. */
export const normalizeMarker = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase()

export function matchesTestRules(
  rules: TestRules,
  utmContent: string | null | undefined,
  utmTerm: string | null | undefined,
  utmSource?: string | null,
  utmMedium?: string | null,
): boolean {
  const content = normalizeMarker(utmContent)
  const term = normalizeMarker(utmTerm)
  const source = normalizeMarker(utmSource)
  const medium = normalizeMarker(utmMedium)
  return (
    (content !== '' && rules.utmContent.some((v) => normalizeMarker(v) === content)) ||
    (term !== '' && rules.utmTerm.some((v) => normalizeMarker(v) === term)) ||
    (source !== '' && medium !== '' && (rules.utmPairs ?? []).some((p) => normalizeMarker(p.source) === source && normalizeMarker(p.medium) === medium))
  )
}

export const FILTER_VALUE_RE = /^[A-Za-z0-9_.-]{1,100}$/
const V = "'[A-Za-z0-9_.-]{1,100}'"
const FILTER_TERM = `(?:ym:s:lastsignUTM(?:Content|Term)==${V}|\\(ym:s:lastsignUTMSource==${V} AND ym:s:lastsignUTMMedium==${V}\\))`
/** The only `filters` shape the client accepts: exact UTM equalities — content, term or a (source AND medium) pair — joined by OR. */
export const ALLOWED_FILTER_RE = new RegExp(`^(?:${FILTER_TERM}(?: OR ${FILTER_TERM})*|ym:s:lastsignTrafficSource=='organic')$`)

// ---- SEO Observer: organic landing pages ---------------------------------------------------------------------------

/**
 * Organic search traffic only: `ym:s:lastsignTrafficSource=='organic'` (the same last-significant-source dimension the rest of the
 * client uses; its value `organic` = search engines, so Direct (`ad`), direct, referral, social etc. are NOT included).
 * Verified on a real counter together with `ym:s:startURLPath` + `ym:s:visits` (2026-10-07).
 */
export const ORGANIC_FILTER = `${DIM.trafficSource}=='organic'`
export const ORGANIC_PAGES_LIMIT = 500

export function organicPagesQuery(limit: number = ORGANIC_PAGES_LIMIT): StatQuery {
  return { dimensions: [DIM.startUrlPath], metrics: ['ym:s:visits'], filters: ORGANIC_FILTER, sort: '-ym:s:visits', limit }
}

export type OrganicPathRow = { path: string; visits: number }

/** Rows of `organicPagesQuery`: landing path + visits. A malformed row (no path, no number) is skipped, never fatal. */
export function parseOrganicPages(r: StatResponse): OrganicPathRow[] {
  const out: OrganicPathRow[] = []
  for (const row of r.rows) {
    const path = row.dimensions[0]?.name
    const visits = row.metrics[0]
    if (typeof path !== 'string' || !path.startsWith('/') || visits === null || visits === undefined || visits < 0) continue
    out.push({ path, visits })
  }
  return out.sort((a, b) => b.visits - a.visits || a.path.localeCompare(b.path))
}

export function dailyGoalsQuery(): StatQuery {
  return { dimensions: [DIM.date], metrics: [visitsMetric('quiz_start'), visitsMetric('lead_submit')], sort: DIM.date, limit: MAX_DAYS + 8 }
}

/** Visits and goal visits/reaches per Direct campaign (`lastDirectClickOrder`): the Direct-click segment, no filter syntax needed. */
export function directSegmentQuery(): StatQuery {
  return {
    dimensions: [DIM.directCampaign],
    metrics: ['ym:s:visits', ...SEGMENT_EVENTS.flatMap((e) => [visitsMetric(e), reachesMetric(e)])],
    sort: '-ym:s:visits',
    limit: BREAKDOWN_LIMIT,
  }
}

/** Visits and goals of the explicit test markers only (server-side filter, so the rows cannot be cut off by the row limit). */
export function testSegmentQuery(rules: TestRules): StatQuery | null {
  const pairs = rules.utmPairs ?? []
  const singles = [
    ...rules.utmContent.map((v) => [DIM.utmContent, v]),
    ...rules.utmTerm.map((v) => [DIM.utmTerm, v]),
  ]
  if (pairs.length + singles.length === 0) return null
  const values = [...pairs.flatMap((p) => [p.source, p.medium]), ...singles.map(([, v]) => v)]
  if (!values.every((v) => FILTER_VALUE_RE.test(v))) throw new ReportFormatError('test marker has unexpected characters')
  return {
    dimensions: [DIM.utmSource, DIM.utmMedium, DIM.utmContent, DIM.utmTerm],
    metrics: ['ym:s:visits', ...SEGMENT_EVENTS.map(visitsMetric), reachesMetric('lead_submit')],
    sort: '-ym:s:visits',
    limit: BREAKDOWN_LIMIT,
    filters: [
      ...pairs.map((p) => `(${DIM.utmSource}=='${p.source}' AND ${DIM.utmMedium}=='${p.medium}')`),
      ...singles.map(([d, v]) => `${d}=='${v}'`),
    ].join(' OR '),
  }
}

export type DailyGoalRow = { date: string; quizStartVisits: number | null; leadSubmitVisits: number | null }
export const parseDailyGoals = (r: StatResponse): DailyGoalRow[] =>
  r.rows.map((row) => ({ date: row.dimensions[0]?.name ?? '', quizStartVisits: row.metrics[0] ?? null, leadSubmitVisits: row.metrics[1] ?? null })).filter((d) => d.date !== '')

export type GoalCounts = { visits: number | null; reaches: number | null }
export type DirectSegment = { campaignId: number; found: boolean; /** false when Metrika answered rows that carry no campaign id at all (matching is then impossible). */ idsPresent: boolean; visits: number | null; goals: Record<string, GoalCounts> }

/** The row whose `lastDirectClickOrder.id` equals the campaign id (exact id match; the name is never used to match). */
export function parseDirectSegment(r: StatResponse, campaignId: number): DirectSegment {
  const row = r.rows.find((x) => x.dimensions[0]?.id === String(campaignId))
  const goals: Record<string, GoalCounts> = {}
  SEGMENT_EVENTS.forEach((event, i) => {
    goals[event] = { visits: row ? (row.metrics[1 + i * 2] ?? null) : 0, reaches: row ? (row.metrics[2 + i * 2] ?? null) : 0 }
  })
  return { campaignId, found: row !== undefined, idsPresent: r.rows.length === 0 || r.rows.some((x) => x.dimensions[0]?.id != null), visits: row ? (row.metrics[0] ?? null) : 0, goals }
}

export type TestSegment = { visits: number; goalVisits: Record<string, number>; leadSubmitReaches: number; rows: number }

export const emptyTestSegment = (): TestSegment => ({ visits: 0, goalVisits: Object.fromEntries(SEGMENT_EVENTS.map((e) => [e, 0])), leadSubmitReaches: 0, rows: 0 })

/** Sums only rows that satisfy the exact rules (a defensive re-check of the server-side filter). */
export function parseTestSegment(r: StatResponse, rules: TestRules): TestSegment {
  const out = emptyTestSegment()
  for (const row of r.rows) {
    if (!matchesTestRules(rules, row.dimensions[2]?.name, row.dimensions[3]?.name, row.dimensions[0]?.name, row.dimensions[1]?.name)) continue
    out.rows++
    out.visits += row.metrics[0] ?? 0
    SEGMENT_EVENTS.forEach((e, i) => {
      out.goalVisits[e] += row.metrics[1 + i] ?? 0
    })
    out.leadSubmitReaches += row.metrics[1 + SEGMENT_EVENTS.length] ?? 0
  }
  return out
}

export type UnifiedExtras = {
  dailyGoals: DailyGoalRow[] | null
  directSegment: DirectSegment | null
  /** null = the test-segment read failed; zeros = no rule matched anything / no rules configured. */
  testSegment: TestSegment | null
  sampled: boolean
  warnings: Warning[]
}
