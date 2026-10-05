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
} as const

export const ALLOWED_DIMENSIONS: readonly string[] = Object.values(DIM)
/** Visit metrics and per-goal metrics only. */
export const ALLOWED_METRIC_RE = /^ym:s:(visits|users|bounceRate|avgVisitDurationSeconds|goal\d+(reaches|visits))$/

export type StatQuery = { dimensions: string[]; metrics: string[]; sort?: string; limit: number }

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
