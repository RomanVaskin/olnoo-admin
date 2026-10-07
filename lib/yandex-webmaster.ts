// Yandex Webmaster API v4 — READ-ONLY client for the SEO Observer: the popular search queries of one host.
// Token: server env only (`YANDEX_WEBMASTER_TOKEN`, OAuth with webmaster:hostinfo) — never returned, stored in a snapshot or logged.
// Only GET requests to three fixed paths exist here; there is no write method. Shared HTTP helper: lib/fetch-retry.ts.
//
// Endpoints (official Webmaster API v4 reference):
//   GET /v4/user                                              → { user_id }
//   GET /v4/user/{user-id}/hosts                              → { hosts: [{ host_id, ascii_host_url, unicode_host_url, ... }] }
//   GET /v4/user/{user-id}/hosts/{host-id}/search-queries/popular
//       ?order_by=TOTAL_SHOWS&query_indicator=TOTAL_SHOWS&query_indicator=TOTAL_CLICKS&query_indicator=AVG_SHOW_POSITION
//        &date_from=&date_to=&limit=                           → { queries: [{ query_id, query_text, indicators: {…} }], date_from, date_to, count }
// The popular-queries report has NO CTR (computed here: clicks / impressions * 100) and NO per-URL split.
import { fetchTextWithRetry, FetchRetryError, type RetryOptions } from './fetch-retry.ts'

const API_HOST = 'https://api.webmaster.yandex.net'
const TIMEOUT_MS = 20_000
export const QUERIES_LIMIT = 500

export type WebmasterErrorKind = 'not_configured' | 'host_not_found' | 'auth' | 'rights' | 'quota' | 'request' | 'upstream' | 'network' | 'format'

export class WebmasterApiError extends Error {
  kind: WebmasterErrorKind
  constructor(kind: WebmasterErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export type WebmasterConfig = { token: string }

export function webmasterConfigFromEnv(env: Record<string, string | undefined> = process.env): WebmasterConfig | null {
  const token = env.YANDEX_WEBMASTER_TOKEN?.trim()
  return token ? { token } : null
}

export type QueryRow = { query: string; impressions: number; clicks: number; ctr: number | null; avgPosition: number | null }

const round2 = (v: number) => Math.round(v * 100) / 100
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** CTR in percent, computed by code; no impressions → null (never a fake 0). */
export function computeCtr(clicks: number, impressions: number): number | null {
  return impressions > 0 ? round2((clicks / impressions) * 100) : null
}

/**
 * Normalises the `queries` array of the popular-queries answer. A malformed row (no text, no numeric impressions) is skipped and
 * never breaks the snapshot. Deterministic order: impressions desc, clicks desc, query asc. Bounded by `limit`.
 */
export function normalizeQueryRows(raw: unknown, limit: number = QUERIES_LIMIT): QueryRow[] {
  if (!Array.isArray(raw)) return []
  const rows: QueryRow[] = []
  for (const item of raw) {
    const o = (item ?? {}) as { query_text?: unknown; indicators?: Record<string, unknown> }
    const query = typeof o.query_text === 'string' ? o.query_text.trim() : ''
    const ind = o.indicators && typeof o.indicators === 'object' ? o.indicators : {}
    const impressions = finite(ind.TOTAL_SHOWS)
    if (!query || impressions === null || impressions < 0) continue
    const clicks = finite(ind.TOTAL_CLICKS) ?? 0
    const position = finite(ind.AVG_SHOW_POSITION)
    rows.push({ query, impressions, clicks, ctr: computeCtr(clicks, impressions), avgPosition: position === null ? null : round2(position) })
  }
  return rows.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query)).slice(0, limit)
}

const hostOf = (value: string) =>
  value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/:].*$/, '')

/** Picks the Webmaster host that matches the project's domain (https preferred, then the shortest id). Null = not added in Webmaster. */
export function pickHostId(hosts: unknown, domain: string): string | null {
  if (!Array.isArray(hosts)) return null
  const want = hostOf(domain)
  const matches = hosts
    .map((h) => (h ?? {}) as { host_id?: unknown; ascii_host_url?: unknown; unicode_host_url?: unknown })
    .filter((h) => typeof h.host_id === 'string' && [h.ascii_host_url, h.unicode_host_url].some((u) => typeof u === 'string' && hostOf(u) === want))
    .map((h) => h.host_id as string)
  matches.sort((a, b) => Number(b.startsWith('https:')) - Number(a.startsWith('https:')) || a.length - b.length || a.localeCompare(b))
  return matches[0] ?? null
}

export type WebmasterDeps = { retry?: RetryOptions }

export function createWebmasterClient(config: WebmasterConfig, deps: WebmasterDeps = {}) {
  const retry: RetryOptions = { attempts: 2, timeoutMs: TIMEOUT_MS, logTag: 'yandex-webmaster', ...deps.retry }
  const headers = { Authorization: `OAuth ${config.token}`, Accept: 'application/json' }
  const redact = (text: string) => text.split(config.token).join('[redacted]')

  async function get(path: string, query: [string, string][] = []): Promise<unknown> {
    const url = new URL(path, API_HOST)
    for (const [k, v] of query) url.searchParams.append(k, v)
    let res
    try {
      res = await fetchTextWithRetry(url.toString(), { method: 'GET', headers }, retry)
    } catch (err) {
      if (err instanceof FetchRetryError) {
        const http = /HTTP (\d{3})/.exec(err.message)
        throw new WebmasterApiError(http && Number(http[1]) === 429 ? 'quota' : http ? 'upstream' : 'network', 'Yandex Webmaster is unavailable')
      }
      throw err
    }
    if (res.status === 401) throw new WebmasterApiError('auth', 'Webmaster token is invalid or expired')
    if (res.status === 403) throw new WebmasterApiError('rights', 'No access to this host in Webmaster')
    if (res.status === 429) throw new WebmasterApiError('quota', 'Webmaster quota exceeded')
    if (res.status >= 500) throw new WebmasterApiError('upstream', 'Yandex Webmaster is unavailable')
    if (res.status !== 200) throw new WebmasterApiError('request', redact(`Webmaster rejected the request (HTTP ${res.status})`))
    try {
      return JSON.parse(res.text)
    } catch {
      throw new WebmasterApiError('format', 'Webmaster returned an unreadable answer')
    }
  }

  async function findHostId(domain: string): Promise<string> {
    const user = (await get('/v4/user')) as { user_id?: unknown }
    const userId = user?.user_id
    if (typeof userId !== 'number' && typeof userId !== 'string') throw new WebmasterApiError('format', 'Webmaster returned no user id')
    const hosts = (await get(`/v4/user/${encodeURIComponent(String(userId))}/hosts`)) as { hosts?: unknown }
    const hostId = pickHostId(hosts?.hosts, domain)
    if (!hostId) throw new WebmasterApiError('host_not_found', 'The site is not added to Yandex Webmaster for this token')
    // keep the user id with the host for the next call
    return `${userId}\u0000${hostId}`
  }

  /** Popular queries of the host for [dateFrom, dateTo] (YYYY-MM-DD): impressions, clicks, average show position. */
  async function popularQueries(domain: string, period: { from: string; to: string }, limit: number = QUERIES_LIMIT): Promise<QueryRow[]> {
    const [userId, hostId] = (await findHostId(domain)).split('\u0000')
    const json = (await get(`/v4/user/${encodeURIComponent(userId)}/hosts/${encodeURIComponent(hostId)}/search-queries/popular`, [
      ['order_by', 'TOTAL_SHOWS'],
      ['query_indicator', 'TOTAL_SHOWS'],
      ['query_indicator', 'TOTAL_CLICKS'],
      ['query_indicator', 'AVG_SHOW_POSITION'],
      ['date_from', period.from],
      ['date_to', period.to],
      ['limit', String(limit)],
    ])) as { queries?: unknown }
    if (!json || typeof json !== 'object' || !Array.isArray(json.queries)) throw new WebmasterApiError('format', 'Webmaster answer has no queries')
    return normalizeQueryRows(json.queries, limit)
  }

  return { popularQueries }
}
