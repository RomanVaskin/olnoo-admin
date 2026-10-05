// Minimal READ-ONLY Yandex Direct API client for the OLNOO Ads Observer (server-side only).
// It calls exactly: campaigns.get, adgroups.get, keywords.get (JSON services) and the Reports service. Nothing here can change
// Direct: only an explicit list of read methods is accepted, and no write method is implemented.
// The OAuth token comes from the server env, is never logged, and is stripped from every error.
// Deterministic integration layer — no AI, no DB, no UI knowledge.

import { fetchTextWithRetry, FetchRetryError, type RetryOptions } from './fetch-retry.ts'
import {
  ADGROUP_FIELDS,
  buildObserverPayload,
  dailyReport,
  KEYWORD_FIELDS,
  normalizeAdGroups,
  normalizeCampaignSettings,
  normalizeKeywords,
  normalizeNegativeKeywords,
  observerPeriod,
  parseReportTsv,
  ReportFormatError,
  searchQueryReport,
  toDailyRows,
  toSearchQueryRows,
  DAILY_FIELDS,
  SEARCH_QUERY_FIELDS,
  SEARCH_QUERY_FIELDS_WITHOUT_CATEGORY,
  type CampaignMeta,
  type CampaignSettings,
  type DirectStructure,
  type ObserverPayload,
  type ReportDefinition,
} from './yandex-direct-report.ts'

const API_BASE = 'https://api.direct.yandex.com/json/v501'
const REPORTS_URL = `${API_BASE}/reports`

/** The only (service, method) pairs the client will send. Writes are deliberately not representable. */
const READ_ONLY_METHODS: Record<string, readonly string[]> = { campaigns: ['get'], adgroups: ['get'], keywords: ['get'] }

// Reports: at most 20 requests / 10 s and 5 offline reports in the queue per user. Calls are strictly
// sequential with a gap that keeps us far below the rate limit; the poll loop is bounded.
const MIN_GAP_MS = 600
const REQUEST_TIMEOUT_MS = 30_000
const REPORT_MAX_POLLS = 12
const REPORT_DEADLINE_MS = 45_000 // keeps the whole HTTP request under typical 60 s proxy timeouts
const DEFAULT_RETRY_IN_S = 5
const MAX_RETRY_IN_S = 15
const BUSY_ATTEMPTS = 3
// Structure reads are paged (Direct answers `LimitedBy` = next offset when a page is full).
const STRUCTURE_PAGE_LIMIT = 2_000
const STRUCTURE_MAX_PAGES = 5

export function isReadOnlyDirectMethod(service: string, method: string): boolean {
  return READ_ONLY_METHODS[service]?.includes(method) === true
}

export type DirectErrorKind =
  | 'not_configured'
  | 'forbidden_campaign'
  | 'campaign_not_found'
  | 'auth' // 53: invalid/revoked token
  | 'rights' // 54
  | 'quota' // 152: not enough points
  | 'busy' // 52 / 506: transient on Direct's side
  | 'request' // any other Direct rejection
  | 'network'
  | 'report_timeout'
  | 'report_format'

export class DirectApiError extends Error {
  kind: DirectErrorKind
  directCode: number | null
  requestId: string | null
  constructor(kind: DirectErrorKind, message: string, extra: { directCode?: number | null; requestId?: string | null } = {}) {
    super(message)
    this.name = 'DirectApiError'
    this.kind = kind
    this.directCode = extra.directCode ?? null
    this.requestId = extra.requestId ?? null
  }
}

/** HTTP status our own endpoint answers with for each failure kind. */
export function directErrorHttpStatus(kind: DirectErrorKind): number {
  switch (kind) {
    case 'not_configured':
      return 503
    case 'forbidden_campaign':
      return 403
    case 'campaign_not_found':
      return 404
    case 'quota':
      return 429
    case 'report_timeout':
      return 504
    case 'busy':
      return 503
    default:
      return 502
  }
}

export type DirectConfig = { token: string; campaignIds: number[] }

/** null = not configured (token or allow-list missing/invalid) — callers answer 503. */
export function directConfigFromEnv(env: Record<string, string | undefined> = process.env): DirectConfig | null {
  const token = env.YANDEX_DIRECT_TOKEN?.trim()
  const rawIds = env.YANDEX_DIRECT_CAMPAIGN_IDS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  if (!token || rawIds.length === 0 || !rawIds.every((id) => /^\d+$/.test(id))) return null
  return { token, campaignIds: rawIds.map(Number) }
}

/** The caller may not choose an arbitrary campaign: it must be one of the configured ids. */
export function resolveCampaignId(requested: string | null, allowed: number[]): number {
  if (requested === null || requested === '') {
    if (allowed.length === 1) return allowed[0]
    throw new DirectApiError('request', 'campaignId is required when several campaigns are allowed')
  }
  const id = /^\d+$/.test(requested) ? Number(requested) : NaN
  if (!allowed.includes(id)) throw new DirectApiError('forbidden_campaign', 'campaign is not in the allowed list')
  return id
}

export type DirectDeps = {
  sleep?: (ms: number) => Promise<void>
  /** Monotonic-ish clock in ms; tests advance it from `sleep`. */
  now?: () => number
  retry?: RetryOptions
  minGapMs?: number
}

export function createDirectClient(config: DirectConfig, deps: DirectDeps = {}) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const minGap = deps.minGapMs ?? MIN_GAP_MS
  const retry: RetryOptions = { attempts: 3, timeoutMs: REQUEST_TIMEOUT_MS, logTag: 'yandex-direct', ...deps.retry }

  let lastCallAt = -Infinity
  let units: string | null = null
  const requestIds: string[] = []

  const redact = (text: string) => (config.token ? text.split(config.token).join('[redacted]') : text)

  const headers = {
    Authorization: `Bearer ${config.token}`,
    'Accept-Language': 'ru',
    'Content-Type': 'application/json; charset=utf-8',
    // Client-Login is intentionally not sent (own account).
  }

  async function gate() {
    const wait = lastCallAt + minGap - now()
    if (wait > 0) await sleep(wait)
    lastCallAt = now()
  }

  function note(h: Headers) {
    const id = h.get('RequestId')
    if (id && !requestIds.includes(id)) requestIds.push(id)
    units = h.get('Units') ?? units
  }

  function errorFrom(status: number, text: string, h: Headers): DirectApiError {
    let code: number | null = null
    let detail = ''
    let requestId = h.get('RequestId')
    try {
      const parsed = JSON.parse(text) as { error?: { error_code?: number | string; error_string?: string; error_detail?: string; request_id?: string | number } }
      const e = parsed.error
      if (e) {
        code = Number(e.error_code) || null
        detail = [e.error_string, e.error_detail].filter(Boolean).join(': ')
        if (e.request_id !== undefined) requestId = String(e.request_id)
      }
    } catch {
      // not JSON: only the status is reported, never the raw body
    }
    if (requestId && !requestIds.includes(requestId)) requestIds.push(requestId)
    const kind: DirectErrorKind =
      code === 53 ? 'auth' : code === 54 ? 'rights' : code === 152 ? 'quota' : code === 52 || code === 506 ? 'busy' : 'request'
    const message = redact(detail || `Direct answered HTTP ${status}`) + (code ? ` (Direct error ${code})` : '')
    return new DirectApiError(kind, message, { directCode: code, requestId })
  }

  /** One POST; retries Direct's transient answers (52 / 506) and the network layer's own transient failures. */
  async function send(url: string, body: string, mode: 'json' | 'report'): Promise<{ status: number; text: string; headers: Headers }> {
    for (let attempt = 1; ; attempt++) {
      await gate()
      let res
      try {
        res = await fetchTextWithRetry(url, { method: 'POST', headers, body }, retry)
      } catch (err) {
        if (err instanceof FetchRetryError) throw new DirectApiError('network', redact(err.message))
        throw err
      }
      note(res.headers)

      let failure: DirectApiError | null = null
      if (res.status === 201 || res.status === 202) {
        if (mode === 'report') return res
        failure = errorFrom(res.status, res.text, res.headers)
      } else if (res.status === 200) {
        if (mode === 'report') return res
        const hasError = /"error"\s*:/.test(res.text) && !/"result"\s*:/.test(res.text)
        if (!hasError) return res
        failure = errorFrom(res.status, res.text, res.headers)
      } else {
        failure = errorFrom(res.status, res.text, res.headers)
      }
      if (failure.kind === 'busy' && attempt < BUSY_ATTEMPTS) {
        await sleep(1_000 * attempt)
        continue
      }
      throw failure
    }
  }

  async function callJson(service: string, method: string, params: unknown): Promise<unknown> {
    if (!isReadOnlyDirectMethod(service, method)) {
      throw new DirectApiError('request', `Direct method ${service}.${method} is not allowed: this client is read-only`)
    }
    const res = await send(`${API_BASE}/${service}`, JSON.stringify({ method, params }), 'json')
    try {
      return (JSON.parse(res.text) as { result?: unknown }).result
    } catch {
      throw new DirectApiError('request', `Direct returned an unreadable ${service}.${method} response`)
    }
  }

  /** Offline Reports lifecycle: POST → 201/202 → wait `retryIn` → the SAME request again → 200 (TSV). */
  async function runReport(def: ReportDefinition): Promise<string> {
    const body = JSON.stringify(def) // serialised once: every retry is byte-identical, never a new definition
    const startedAt = now()
    for (let poll = 1; poll <= REPORT_MAX_POLLS; poll++) {
      const res = await send(REPORTS_URL, body, 'report')
      if (res.status === 200) return res.text

      const retryIn = Number(res.headers.get('retryIn'))
      const waitS = Math.min(MAX_RETRY_IN_S, Number.isFinite(retryIn) && retryIn > 0 ? retryIn : DEFAULT_RETRY_IN_S)
      if (now() - startedAt + waitS * 1_000 > REPORT_DEADLINE_MS) break
      await sleep(waitS * 1_000)
    }
    throw new DirectApiError('report_timeout', `Direct report ${def.params.ReportName} was not ready in time`, { requestId: requestIds[requestIds.length - 1] ?? null })
  }

  function rows(text: string, fields: string[]) {
    try {
      return parseReportTsv(text, fields)
    } catch (err) {
      if (err instanceof ReportFormatError) throw new DirectApiError('report_format', err.message, { requestId: requestIds[requestIds.length - 1] ?? null })
      throw err
    }
  }

  async function getCampaign(campaignId: number): Promise<CampaignMeta> {
    // The type-specific blocks are requested for both text and unified campaigns; Direct returns only the one that matches.
    const typeFields = ['CounterIds', 'BiddingStrategy', 'Settings', 'NegativeKeywordSharedSetIds']
    const result = (await callJson('campaigns', 'get', {
      SelectionCriteria: { Ids: [campaignId] },
      FieldNames: ['Id', 'Name', 'State', 'Status', 'Type', 'StartDate', 'EndDate', 'TimeZone', 'Currency', 'DailyBudget', 'NegativeKeywords'],
      TextCampaignFieldNames: typeFields,
      UnifiedCampaignFieldNames: typeFields,
    })) as { Campaigns?: ({ Id: number; Name: string; State: string; Status: string; Type: string; StartDate?: string } & Record<string, unknown>)[] } | undefined
    const c = result?.Campaigns?.find((item) => Number(item.Id) === campaignId)
    if (!c) throw new DirectApiError('campaign_not_found', 'campaign not found in Direct')
    return {
      id: Number(c.Id),
      name: c.Name,
      state: c.State,
      status: c.Status,
      type: c.Type,
      startDate: c.StartDate ?? null,
      settings: normalizeCampaignSettings(c),
    }
  }

  /**
   * All pages of one read-only list. The selection is ALWAYS `CampaignIds: [campaignId]` with the id that already
   * passed the allow-list, and rows of any other campaign are dropped, so an ad group / keyword id can never be
   * used to read another campaign.
   */
  async function getAllForCampaign(
    service: 'adgroups' | 'keywords',
    resultKey: 'AdGroups' | 'Keywords',
    campaignId: number,
    fieldNames: string[],
    extraSelection: Record<string, unknown> = {},
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    const rows: Record<string, unknown>[] = []
    let offset = 0
    for (let page = 1; page <= STRUCTURE_MAX_PAGES; page++) {
      const result = (await callJson(service, 'get', {
        SelectionCriteria: { CampaignIds: [campaignId], ...extraSelection },
        FieldNames: fieldNames,
        Page: { Limit: STRUCTURE_PAGE_LIMIT, Offset: offset },
      })) as ({ LimitedBy?: number } & Partial<Record<string, Record<string, unknown>[]>>) | undefined
      for (const row of result?.[resultKey] ?? []) {
        if (Number(row.CampaignId) === campaignId) rows.push(row)
      }
      const next = result?.LimitedBy
      if (typeof next !== 'number' || next <= offset) return { rows, truncated: false }
      offset = next
    }
    return { rows, truncated: true }
  }

  /** Ad groups, keywords (with real bids) and negative keywords of the campaign: 2+ sequential requests, no per-object calls. */
  async function getStructure(campaignId: number, settings: CampaignSettings): Promise<DirectStructure> {
    const groups = await getAllForCampaign('adgroups', 'AdGroups', campaignId, ADGROUP_FIELDS)
    const keywords = await getAllForCampaign('keywords', 'Keywords', campaignId, KEYWORD_FIELDS, { States: ['ON', 'OFF', 'SUSPENDED'] })
    return {
      adGroups: normalizeAdGroups(groups.rows),
      adGroupsTruncated: groups.truncated,
      keywords: { items: normalizeKeywords(keywords.rows), truncated: keywords.truncated },
      negativeKeywords: normalizeNegativeKeywords(settings, groups.rows),
    }
  }

  /**
   * Campaign (+ settings), daily stats and search queries for the inclusive Moscow-day range `period`
   * (may end today: Direct's current-day numbers are partial); with `structure` also ad groups, keywords and
   * negative keywords. Sequential on purpose. If a requested structure read fails the whole request fails:
   * negative-keyword checks ("is this already excluded?") must never be answered from a half-read structure.
   * `observe(campaignId, days)` below is the original "last N complete days" entry point and delegates here.
   */
  async function observePeriod(campaignId: number, period: { from: string; to: string }, opts: { structure?: boolean } = {}): Promise<ObserverPayload> {
    const campaign = await getCampaign(campaignId)
    const daily = toDailyRows(rows(await runReport(dailyReport(campaignId, period.from, period.to)), DAILY_FIELDS))

    let queryRows
    try {
      queryRows = rows(await runReport(searchQueryReport(campaignId, period.from, period.to)), SEARCH_QUERY_FIELDS)
    } catch (err) {
      // TargetingCategory is deprecated; if Direct rejects exactly that field, ask again without it.
      if (!(err instanceof DirectApiError) || err.kind !== 'request' || !/TargetingCategory/i.test(err.message)) throw err
      queryRows = rows(await runReport(searchQueryReport(campaignId, period.from, period.to, false)), SEARCH_QUERY_FIELDS_WITHOUT_CATEGORY)
    }

    const structure = opts.structure ? await getStructure(campaignId, campaign.settings) : undefined

    return buildObserverPayload({ period, campaign, daily, searchQueries: toSearchQueryRows(queryRows), structure, units, requestIds: [...requestIds] })
  }

  /** Last `days` complete days in Moscow time (the period ends yesterday) — the Direct Observer endpoint's contract. */
  async function observe(campaignId: number, days: number, opts: { structure?: boolean } = {}): Promise<ObserverPayload> {
    return observePeriod(campaignId, observerPeriod(new Date(now()), days), opts)
  }

  return { observe, observePeriod, getCampaign }
}
