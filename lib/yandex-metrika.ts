// READ-ONLY Yandex Metrika client for the OLNOO Metrika Observer v0.1 (server-side only).
// It sends exactly two kinds of GET request: the Reporting API (/stat/v1/data, aggregated visits/goals) and the
// Management API goal list of an allow-listed counter. No write method exists, no Logs API, no visitor-level
// dimension (see ALLOWED_DIMENSIONS). The OAuth token (`YANDEX_METRIKA_TOKEN`, scope metrika:read — never the
// Direct token) comes from the server env, is never logged and is stripped from every error.

import { fetchTextWithRetry, FetchRetryError, type RetryOptions } from './fetch-retry.ts'
import type { ResolvedPeriod } from './observer-period.ts'
import {
  ALLOWED_FILTER_RE,
  ALLOWED_DIMENSIONS,
  ALLOWED_METRIC_RE,
  breakdownQuery,
  buildMetrikaPayload,
  checkGoals,
  dailyGoalsQuery,
  dailyQuery,
  directSegmentQuery,
  emptyTestSegment,
  parseDailyGoals,
  parseDirectSegment,
  parseTestSegment,
  testSegmentQuery,
  type DailyGoalRow,
  type DirectSegment,
  type TestRules,
  type UnifiedExtras,
  type TestSegment,
  type Warning,
  DIM,
  goalsQuery,
  parseManagedGoals,
  parseStatResponse,
  ReportFormatError,
  type GoalSpec,
  type ManagedGoal,
  type MetrikaPayload,
  type StatQuery,
  type StatResponse,
} from './yandex-metrika-report.ts'

const API_HOST = 'https://api-metrika.yandex.net'
const REPORTING_URL = `${API_HOST}/stat/v1/data`
const REQUEST_TIMEOUT_MS = 30_000

/** Project slug → Metrika counter. Not a secret; no DB table for it. */
export const METRIKA_PROJECTS: Readonly<Record<string, { counterId: number; timezone: string }>> = {
  driveset: { counterId: 113053562, timezone: 'Europe/Moscow' },
}

export type MetrikaErrorKind =
  | 'not_configured'
  | 'unknown_project'
  | 'auth' // 401: invalid / revoked token
  | 'rights' // 403: no access to the counter
  | 'quota' // 429
  | 'request' // 400 and other rejections of the query
  | 'upstream' // 5xx
  | 'network'
  | 'report_format'

export class MetrikaApiError extends Error {
  kind: MetrikaErrorKind
  metrikaCode: string | null
  constructor(kind: MetrikaErrorKind, message: string, metrikaCode: string | null = null) {
    super(message)
    this.name = 'MetrikaApiError'
    this.kind = kind
    this.metrikaCode = metrikaCode
  }
}

export function metrikaErrorHttpStatus(kind: MetrikaErrorKind): number {
  switch (kind) {
    case 'not_configured':
      return 503
    case 'unknown_project':
      return 404
    case 'quota':
      return 429
    default:
      return 502
  }
}

export type MetrikaConfig = { token: string }

/** null = not configured (token missing or with unexpected characters) — callers answer 503. */
export function metrikaConfigFromEnv(env: Record<string, string | undefined> = process.env): MetrikaConfig | null {
  const token = env.YANDEX_METRIKA_TOKEN?.trim()
  return token && /^[A-Za-z0-9_.-]+$/.test(token) ? { token } : null
}

export function resolveMetrikaProject(slug: string): { counterId: number; timezone: string } {
  if (!Object.prototype.hasOwnProperty.call(METRIKA_PROJECTS, slug)) throw new MetrikaApiError('unknown_project', 'project has no Metrika counter')
  return METRIKA_PROJECTS[slug]
}

export type MetrikaDeps = { retry?: RetryOptions; now?: () => Date }

export function createMetrikaClient(config: MetrikaConfig, deps: MetrikaDeps = {}) {
  const retry: RetryOptions = { attempts: 2, timeoutMs: REQUEST_TIMEOUT_MS, logTag: 'yandex-metrika', ...deps.retry }
  const clock = deps.now ?? (() => new Date())
  const headers = { Authorization: `OAuth ${config.token}`, Accept: 'application/json' }
  let requests = 0

  const redact = (text: string) => text.split(config.token).join('[redacted]')

  function errorFrom(status: number, text: string): MetrikaApiError {
    let code: string | null = null
    let detail = ''
    try {
      const parsed = JSON.parse(text) as { errors?: { error_type?: string; message?: string }[]; message?: string }
      const first = parsed.errors?.[0]
      code = first?.error_type ?? null
      detail = first?.message ?? parsed.message ?? ''
    } catch {
      // not JSON: only the status is reported, never the raw body
    }
    const kind: MetrikaErrorKind = status === 401 ? 'auth' : status === 403 ? 'rights' : status === 429 ? 'quota' : status >= 500 ? 'upstream' : 'request'
    return new MetrikaApiError(kind, redact(detail || `Metrika answered HTTP ${status}`), code)
  }

  /** The only requests this client can send. */
  function assertReadOnlyUrl(url: URL, counterId: number) {
    const reporting = url.origin + url.pathname === REPORTING_URL
    const goals = url.origin + url.pathname === `${API_HOST}/management/v1/counter/${counterId}/goals`
    if (!reporting && !goals) throw new MetrikaApiError('request', 'this client is read-only: the request is not allowed')
    if (reporting && url.searchParams.get('ids') !== String(counterId)) throw new MetrikaApiError('request', 'counter is not allowed')
  }

  async function get(url: URL, counterId: number): Promise<unknown> {
    assertReadOnlyUrl(url, counterId)
    requests++
    let res
    try {
      res = await fetchTextWithRetry(url.toString(), { method: 'GET', headers }, retry)
    } catch (err) {
      if (err instanceof FetchRetryError) {
        // fetchTextWithRetry gives up on 429/5xx after its attempts and reports the last HTTP status in the message.
        const http = /HTTP (\d{3})/.exec(err.message)
        if (http) throw errorFrom(Number(http[1]), '')
        throw new MetrikaApiError('network', 'Metrika is unreachable')
      }
      throw err
    }
    if (res.status !== 200) throw errorFrom(res.status, res.text)
    try {
      return JSON.parse(res.text)
    } catch {
      throw new MetrikaApiError('report_format', 'Metrika returned an unreadable answer')
    }
  }

  function statUrl(query: StatQuery, counterId: number, period: ResolvedPeriod): URL {
    if (!query.dimensions.every((d) => ALLOWED_DIMENSIONS.includes(d))) throw new MetrikaApiError('request', 'dimension is not allowed')
    if (!query.metrics.every((m) => ALLOWED_METRIC_RE.test(m))) throw new MetrikaApiError('request', 'metric is not allowed')
    const url = new URL(REPORTING_URL)
    url.searchParams.set('ids', String(counterId))
    url.searchParams.set('date1', period.from)
    url.searchParams.set('date2', period.to)
    url.searchParams.set('metrics', query.metrics.join(','))
    if (query.dimensions.length) url.searchParams.set('dimensions', query.dimensions.join(','))
    if (query.filters !== undefined) {
      if (!ALLOWED_FILTER_RE.test(query.filters)) throw new MetrikaApiError('request', 'filter is not allowed')
      url.searchParams.set('filters', query.filters)
    }
    if (query.sort) url.searchParams.set('sort', query.sort)
    url.searchParams.set('limit', String(query.limit))
    url.searchParams.set('accuracy', 'full') // ask for unsampled data; `sampled` is reported either way
    url.searchParams.set('lang', 'ru')
    return url
  }

  async function stat(query: StatQuery, counterId: number, period: ResolvedPeriod): Promise<StatResponse> {
    const json = await get(statUrl(query, counterId, period), counterId)
    try {
      return parseStatResponse(json)
    } catch (err) {
      if (err instanceof ReportFormatError) throw new MetrikaApiError('report_format', err.message)
      throw err
    }
  }

  /** A breakdown the counter cannot answer (Metrika rejects the query) degrades to a warning; any other failure is fatal. */
  async function breakdown(dimensions: string[], withLead: boolean, counterId: number, period: ResolvedPeriod) {
    try {
      return { response: await stat(breakdownQuery(dimensions, withLead), counterId, period) }
    } catch (err) {
      if (err instanceof MetrikaApiError && err.kind === 'request') return { response: null, failed: err.metrikaCode ?? 'rejected' }
      throw err
    }
  }

  async function managedGoals(counterId: number): Promise<ManagedGoal[] | null> {
    try {
      return parseManagedGoals(await get(new URL(`${API_HOST}/management/v1/counter/${counterId}/goals`), counterId))
    } catch (err) {
      // The goal list only validates our expectations; its absence is a warning, not a failure.
      if (err instanceof MetrikaApiError || err instanceof ReportFormatError) return null
      throw err
    }
  }

  /** Sequential, ~9 requests: goal list, daily+totals, goals, sources, UTM, 4 Direct breakdowns. */
  async function observe(project: string, period: ResolvedPeriod): Promise<MetrikaPayload> {
    const counter = resolveMetrikaProject(project)
    const id = counter.counterId
    const goalCheck = checkGoals(await managedGoals(id))
    const withLead = goalCheck.present.some((g: GoalSpec) => g.event === 'lead_submit')

    const daily = await stat(dailyQuery(), id, period)
    const goals = goalCheck.present.length ? await stat(goalsQuery(goalCheck.present), id, period) : null
    const sources = await breakdown([DIM.trafficSource], withLead, id, period)
    const utm = await breakdown([DIM.utmSource, DIM.utmMedium, DIM.utmCampaign, DIM.utmContent, DIM.utmTerm], withLead, id, period)
    const directCampaigns = await breakdown([DIM.directCampaign], withLead, id, period)
    const directBanners = await breakdown([DIM.directBanner], withLead, id, period)
    const directPhrasesOrConditions = await breakdown([DIM.directPhraseOrCond], withLead, id, period)
    const directSearchPhrases = await breakdown([DIM.directSearchPhrase], withLead, id, period)

    return buildMetrikaPayload({
      project,
      counter: { id, timezone: counter.timezone },
      period,
      now: clock(),
      goalCheck,
      daily,
      goals,
      sources,
      utm,
      directCampaigns,
      directBanners,
      directPhrasesOrConditions,
      directSearchPhrases,
      requests,
    })
  }

  /**
   * Extra aggregated reads for Unified Analytics (3 sequential requests): goal visits per day, the Direct-click
   * segment of the funnel (`lastDirectClickOrder.id` = the Direct campaign) and the explicit test-traffic segment.
   * Each read is independent: a failure of one becomes a warning and a null, never a failure of the others.
   */
  async function observeUnifiedExtras(project: string, period: ResolvedPeriod, campaignId: number, testRules: TestRules): Promise<UnifiedExtras> {
    const id = resolveMetrikaProject(project).counterId
    const warnings: Warning[] = []
    let sampled = false
    async function tolerant<T>(block: string, read: () => Promise<StatResponse>, parse: (r: StatResponse) => T): Promise<T | null> {
      try {
        const response = await read()
        sampled = sampled || response.sampled
        return parse(response)
      } catch (err) {
        if (err instanceof MetrikaApiError) {
          warnings.push({ code: 'extras_unavailable', message: `${block}: ${err.kind}${err.metrikaCode ? ` (${err.metrikaCode})` : ''}` })
          return null
        }
        throw err
      }
    }
    const dailyGoals = await tolerant('dailyGoals', () => stat(dailyGoalsQuery(), id, period), parseDailyGoals)
    const directSegment = await tolerant('directSegment', () => stat(directSegmentQuery(), id, period), (r) => parseDirectSegment(r, campaignId))
    const testQuery = testSegmentQuery(testRules)
    const testSegment = testQuery ? await tolerant('testSegment', () => stat(testQuery, id, period), (r) => parseTestSegment(r, testRules)) : emptyTestSegment()
    return { dailyGoals, directSegment, testSegment, sampled, warnings }
  }

  return { observe, observeUnifiedExtras, stat }
}
