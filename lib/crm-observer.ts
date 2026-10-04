// CRM Observer (read-only): the leads of ONE project for a calendar period, in a stable shape that a
// later layer can join with Direct and Metrika. Only SELECTs; no write path exists in this module.
// No `@/` imports so it runs under `node --test`; the route passes the pool in.

import type { Pool, PoolClient } from 'pg'

/** Same calendar the Direct Observer uses (its period is "Moscow days"): Moscow has been UTC+3 without DST since 2014. */
export const OBSERVER_TIMEZONE = 'Europe/Moscow'
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export const MAX_PERIOD_DAYS = 92
export const MAX_LEADS = 2_000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export type ObserverPeriod = {
  /** First day, inclusive, YYYY-MM-DD in Moscow time. */
  from: string
  /** Last day, inclusive, YYYY-MM-DD in Moscow time. */
  to: string
  timezone: typeof OBSERVER_TIMEZONE
  /** Instant of `from` 00:00 Moscow (inclusive), ISO UTC. */
  fromUtc: string
  /** Instant of `to`+1 day 00:00 Moscow (EXCLUSIVE), ISO UTC. */
  toUtcExclusive: string
}

export type ObserverQuery = { project: string; period: ObserverPeriod }
export type ObserverError = { error: string; status: number }

/** Strict calendar date: YYYY-MM-DD that round-trips (rejects 2026-02-30, 2026-13-01, "2026-1-1"). */
function parseDay(value: string | null): number | null {
  if (!value || !DATE_RE.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null
}

export function buildPeriod(from: string | null, to: string | null): ObserverPeriod | ObserverError {
  const fromMs = parseDay(from)
  const toMs = parseDay(to)
  if (fromMs === null || toMs === null) return { error: 'from and to are required, as real dates in YYYY-MM-DD', status: 400 }
  if (fromMs > toMs) return { error: 'from must not be after to', status: 400 }
  if ((toMs - fromMs) / DAY_MS + 1 > MAX_PERIOD_DAYS) return { error: `period is limited to ${MAX_PERIOD_DAYS} days`, status: 400 }
  return {
    from: from as string,
    to: to as string,
    timezone: OBSERVER_TIMEZONE,
    // The calendar day D in Moscow starts at D 00:00 UTC minus 3 hours.
    fromUtc: new Date(fromMs - MOSCOW_OFFSET_MS).toISOString(),
    toUtcExclusive: new Date(toMs + DAY_MS - MOSCOW_OFFSET_MS).toISOString(),
  }
}

/**
 * Query-string rules: `project` (a slug) appears exactly once and is never "all"; `from`/`to` are
 * required. Anything else in the query string is ignored — there is no way to pick another filter.
 */
export function parseObserverQuery(params: URLSearchParams): ObserverQuery | ObserverError {
  const projects = params.getAll('project')
  if (projects.length !== 1 || !SLUG_RE.test(projects[0]) || projects[0].toLowerCase() === 'all') {
    return { error: 'exactly one project slug is required', status: 400 }
  }
  const period = buildPeriod(params.get('from'), params.get('to'))
  if ('error' in period) return period
  return { project: projects[0], period }
}

export type ObserverLead = {
  id: string
  /** ISO UTC instant. */
  createdAt: string
  name: string
  phone: string | null
  status: string
  source: string
  service: string
  /** `tg:<id>` for Telegram Business leads, otherwise null. */
  contact: string | null
  landingPage: string
  pagePath: string
  referrer: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  utmContent: string
  utmTerm: string
  /** Attribution identifiers captured by the client; NULL for leads created before A1 or when not sent. Internal: keep out of AI prompts and logs. */
  leadTrackingId: string | null
  /** Yandex Metrika ClientID as a STRING (UInt64, can exceed the JS safe-integer range). */
  metrikaClientId: string | null
  yclid: string | null
  /** ISO UTC; reported by the browser. */
  firstSeenAt: string | null
}

export type ObserverPayload = {
  period: ObserverPeriod
  project: { id: number; slug: string; name: string }
  totals: { leads: number }
  /** True when more than `MAX_LEADS` leads matched: `leads` holds the first MAX_LEADS, `totals.leads` is the real count. */
  truncated: boolean
  leads: ObserverLead[]
}

type Db = Pick<Pool | PoolClient, 'query'>

/** Empty strings are kept as stored: "" means the source did not provide the value. */
export async function readLeadsForPeriod(
  db: Db,
  query: ObserverQuery,
  limit: number = MAX_LEADS,
): Promise<ObserverPayload | ObserverError> {
  const projects = await db.query<{ id: number; slug: string; name: string }>('SELECT id, slug, name FROM projects WHERE slug = $1', [query.project])
  const project = projects.rows[0]
  if (!project) return { error: 'project not found', status: 404 }

  // The project id comes from the slug lookup above and is the only project filter in the statement.
  const { rows } = await db.query(
    `SELECT l.id, l.created_at, l.name, l.phone, l.status, l.source, l.service, l.contact,
            l.landing_page, l.page_path, l.referrer,
            l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term,
            l.lead_tracking_id, l.metrika_client_id, l.yclid, l.first_seen_at,
            count(*) OVER() AS total
       FROM leads l
      WHERE l.project_id = $1
        AND l.created_at >= $2::timestamptz
        AND l.created_at <  $3::timestamptz
      ORDER BY l.created_at ASC, l.id ASC
      LIMIT $4`,
    [project.id, query.period.fromUtc, query.period.toUtcExclusive, limit],
  )

  const total = rows.length > 0 ? Number(rows[0].total) : 0
  return {
    period: query.period,
    project: { id: project.id, slug: project.slug, name: project.name },
    totals: { leads: total },
    truncated: total > rows.length,
    leads: rows.map((r) => ({
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      name: r.name,
      phone: r.phone ?? null,
      status: r.status,
      source: r.source,
      service: r.service,
      contact: r.contact ?? null,
      landingPage: r.landing_page,
      pagePath: r.page_path,
      referrer: r.referrer,
      utmSource: r.utm_source,
      utmMedium: r.utm_medium,
      utmCampaign: r.utm_campaign,
      utmContent: r.utm_content,
      utmTerm: r.utm_term,
      leadTrackingId: r.lead_tracking_id ?? null,
      metrikaClientId: r.metrika_client_id ?? null,
      yclid: r.yclid ?? null,
      firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : null,
    })),
  }
}
