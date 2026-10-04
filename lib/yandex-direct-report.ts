// Pure helpers for the read-only Yandex Direct observer: report definitions, the minimal TSV parser
// and the response shape. No network, no env, no `@/` imports — so it runs under `node --test`.

export const MICROS = 1_000_000

/** Direct returns money as integers × 1 000 000 (we never ask for the rounded form). */
export function microsToMoney(micros: number): number {
  return Math.round(micros / 100) / 10_000
}

export type ReportDefinition = {
  params: {
    SelectionCriteria: {
      DateFrom: string
      DateTo: string
      Filter: { Field: 'CampaignId'; Operator: 'EQUALS'; Values: string[] }[]
    }
    FieldNames: string[]
    ReportName: string
    ReportType: 'CAMPAIGN_PERFORMANCE_REPORT' | 'SEARCH_QUERY_PERFORMANCE_REPORT'
    DateRangeType: 'CUSTOM_DATE'
    Format: 'TSV'
    IncludeVAT: 'YES' | 'NO'
  }
}

export const DAILY_FIELDS = ['Date', 'CampaignId', 'Impressions', 'Clicks', 'Cost']
export const SEARCH_QUERY_FIELDS = ['CampaignId', 'AdGroupId', 'Query', 'Criteria', 'CriteriaType', 'TargetingCategory', 'Impressions', 'Clicks', 'Cost']
/** TargetingCategory is deprecated: it is requested for compatibility only and may be dropped. */
export const SEARCH_QUERY_FIELDS_WITHOUT_CATEGORY = SEARCH_QUERY_FIELDS.filter((f) => f !== 'TargetingCategory')

// Cost includes VAT (what the account is actually charged); the payload says so in `meta.includeVat`.
const INCLUDE_VAT = 'YES'

function definition(
  type: ReportDefinition['params']['ReportType'],
  label: string,
  fields: string[],
  campaignId: number,
  from: string,
  to: string,
): ReportDefinition {
  return {
    params: {
      SelectionCriteria: { DateFrom: from, DateTo: to, Filter: [{ Field: 'CampaignId', Operator: 'EQUALS', Values: [String(campaignId)] }] },
      FieldNames: fields,
      // Deterministic: a re-sent request must be byte-identical and carry the same name.
      ReportName: `olnoo-observer-${label}-${campaignId}-${from}-${to}`,
      ReportType: type,
      DateRangeType: 'CUSTOM_DATE',
      Format: 'TSV',
      IncludeVAT: INCLUDE_VAT,
    },
  }
}

export const dailyReport = (campaignId: number, from: string, to: string) =>
  definition('CAMPAIGN_PERFORMANCE_REPORT', 'daily', DAILY_FIELDS, campaignId, from, to)

export const searchQueryReport = (campaignId: number, from: string, to: string, withTargetingCategory = true) =>
  definition(
    'SEARCH_QUERY_PERFORMANCE_REPORT',
    withTargetingCategory ? 'queries' : 'queries-nocat',
    withTargetingCategory ? SEARCH_QUERY_FIELDS : SEARCH_QUERY_FIELDS_WITHOUT_CATEGORY,
    campaignId,
    from,
    to,
  )

export class ReportFormatError extends Error {}

/**
 * Minimal Direct report TSV parser. Tolerates the title line before the column row and the
 * "Total rows: N" summary after the data, so it does not depend on skip*-headers. Throws if the
 * column row is missing or a data row has the wrong number of cells.
 */
export function parseReportTsv(text: string, fields: string[]): Record<string, string>[] {
  const lines = text.split(/\r?\n/)
  const header = fields.join('\t')
  const headerIndex = lines.findIndex((line) => line === header)
  if (headerIndex < 0) throw new ReportFormatError(`report column row not found (expected: ${fields.join(', ')})`)

  const rows: Record<string, string>[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (line === '') continue
    if (/^Total rows:/i.test(line)) break
    const cells = line.split('\t')
    if (cells.length !== fields.length) {
      throw new ReportFormatError(`report row has ${cells.length} cells, expected ${fields.length}`)
    }
    rows.push(Object.fromEntries(fields.map((field, i) => [field, cells[i]])))
  }
  return rows
}

/** Direct prints "--" for an empty value. */
function intOrNull(value: string | undefined): number | null {
  if (value === undefined || value === '--' || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function intOrZero(value: string | undefined): number {
  return intOrNull(value) ?? 0
}

/** Deterministic CPC: spend / clicks, null (not 0) when there are no clicks. */
export function cpc(spend: number, clicks: number): number | null {
  return clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : null
}

export type DailyRow = { date: string; impressions: number; clicks: number; spend: number; cpc: number | null }

export function toDailyRows(rows: Record<string, string>[]): DailyRow[] {
  return rows
    .map((r) => {
      const clicks = intOrZero(r.Clicks)
      const spend = microsToMoney(intOrZero(r.Cost))
      return { date: r.Date, impressions: intOrZero(r.Impressions), clicks, spend, cpc: cpc(spend, clicks) }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

export type SearchQueryRow = {
  campaignId: number | null
  adGroupId: number | null
  query: string
  /** Direct's raw criterion text, "---autotargeting" for autotargeting. */
  criteria: string
  criteriaType: string
  /** Deprecated raw Direct field, kept only as optional compatibility data. Build no logic on it. */
  targetingCategory?: string | null
  impressions: number
  clicks: number
  spend: number
  cpc: number | null
}

export function toSearchQueryRows(rows: Record<string, string>[]): SearchQueryRow[] {
  return rows
    .map((r) => {
      const clicks = intOrZero(r.Clicks)
      const spend = microsToMoney(intOrZero(r.Cost))
      const row: SearchQueryRow = {
        campaignId: intOrNull(r.CampaignId),
        adGroupId: intOrNull(r.AdGroupId),
        query: r.Query,
        criteria: r.Criteria,
        criteriaType: r.CriteriaType,
        impressions: intOrZero(r.Impressions),
        clicks,
        spend,
        cpc: cpc(spend, clicks),
      }
      if ('TargetingCategory' in r) row.targetingCategory = r.TargetingCategory === '--' ? null : r.TargetingCategory
      return row
    })
    .sort((a, b) => b.spend - a.spend || b.clicks - a.clicks || a.query.localeCompare(b.query))
}

export type CampaignMeta = {
  id: number
  name: string
  state: string
  status: string
  type: string
  startDate: string | null
}

export type ObserverPayload = {
  period: { from: string; to: string }
  campaign: CampaignMeta & { totals: { impressions: number; clicks: number; spend: number; cpc: number | null } }
  daily: DailyRow[]
  searchQueries: SearchQueryRow[]
  meta: { includeVat: boolean; units: string | null; requestIds: string[] }
}

export function buildObserverPayload(input: {
  period: { from: string; to: string }
  campaign: CampaignMeta
  daily: DailyRow[]
  searchQueries: SearchQueryRow[]
  units: string | null
  requestIds: string[]
}): ObserverPayload {
  const impressions = input.daily.reduce((s, d) => s + d.impressions, 0)
  const clicks = input.daily.reduce((s, d) => s + d.clicks, 0)
  const spend = Math.round(input.daily.reduce((s, d) => s + d.spend, 0) * 10_000) / 10_000
  return {
    period: input.period,
    campaign: { ...input.campaign, totals: { impressions, clicks, spend, cpc: cpc(spend, clicks) } },
    daily: input.daily,
    searchQueries: input.searchQueries,
    meta: { includeVat: INCLUDE_VAT === 'YES', units: input.units, requestIds: input.requestIds },
  }
}

/** Last `days` complete days in Moscow time (the period ends yesterday), as YYYY-MM-DD. */
export function observerPeriod(now: Date, days: number): { from: string; to: string } {
  const moscow = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  const day = (offset: number) => {
    const d = new Date(Date.UTC(moscow.getUTCFullYear(), moscow.getUTCMonth(), moscow.getUTCDate() - offset))
    return d.toISOString().slice(0, 10)
  }
  return { from: day(days), to: day(1) }
}
