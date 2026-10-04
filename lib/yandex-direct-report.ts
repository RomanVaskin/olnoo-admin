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
  settings: CampaignSettings
}

export type ObserverPayload = {
  period: { from: string; to: string }
  campaign: CampaignMeta & { totals: { impressions: number; clicks: number; spend: number; cpc: number | null } }
  daily: DailyRow[]
  searchQueries: SearchQueryRow[]
  /** Present only when the caller asked for it (`?structure=1`). */
  structure?: DirectStructure
  meta: { includeVat: boolean; units: string | null; requestIds: string[] }
}

export function buildObserverPayload(input: {
  period: { from: string; to: string }
  campaign: CampaignMeta
  daily: DailyRow[]
  searchQueries: SearchQueryRow[]
  structure?: DirectStructure
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
    ...(input.structure ? { structure: input.structure } : {}),
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

// ---------------------------------------------------------------------------------------------
// Campaign structure (read-only, Observer v0.2). Shapes below follow Direct's own answers:
// campaigns.get → TextCampaign|UnifiedCampaign{BiddingStrategy,Settings,CounterIds,
// NegativeKeywordSharedSetIds}, top-level NegativeKeywords{Items}; adgroups.get (no `State` field —
// `Status` + `ServingStatus`); keywords.get (Bid/ContextBid in micros, autotargeting is the keyword
// "---autotargeting"). Money fields are micros, converted like everywhere else.
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function microsOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? microsToMoney(n) : null
}

function idOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

/** Direct wraps lists as `{ Items: [...] }` (or null). */
function items(value: unknown): unknown[] {
  const wrapped = obj(value)
  const list = wrapped ? wrapped.Items : value
  return Array.isArray(list) ? list : []
}

function strings(value: unknown): string[] {
  return items(value).filter((v): v is string => typeof v === 'string')
}

function ids(value: unknown): number[] {
  return items(value).map(idOrNull).filter((v): v is number => v !== null)
}

export type StrategySide = {
  type: string
  weeklySpendLimit: number | null
  bidCeiling: number | null
  budgetType: string | null
}

export type CampaignSettings = {
  timeZone: string | null
  currency: string | null
  endDate: string | null
  dailyBudget: { amount: number | null; mode: string | null } | null
  /** Campaign-level negative keywords (phrases exactly as Direct stores them). */
  negativeKeywords: string[]
  negativeKeywordSharedSetIds: number[]
  counterIds: number[]
  strategy: { search: StrategySide | null; network: StrategySide | null }
  /** Direct's campaign options as `OPTION → YES/NO`. */
  options: Record<string, string>
}

function strategySide(raw: unknown): StrategySide | null {
  const side = obj(raw)
  const type = str(side?.BiddingStrategyType)
  if (!side || !type) return null
  // The parameters live in a sibling object named after the strategy type (e.g. WbMaximumClicks).
  const params = Object.entries(side).find(([key, value]) => key !== 'BiddingStrategyType' && obj(value))?.[1] as Json | undefined
  return {
    type,
    weeklySpendLimit: microsOrNull(params?.WeeklySpendLimit),
    bidCeiling: microsOrNull(params?.BidCeiling),
    budgetType: str(params?.BudgetType),
  }
}

/** Normalises one campaigns.get item (TEXT_CAMPAIGN or UNIFIED_CAMPAIGN; absent parts become empty values). */
export function normalizeCampaignSettings(raw: unknown): CampaignSettings {
  const c = obj(raw) ?? {}
  const typed = obj(c.TextCampaign) ?? obj(c.UnifiedCampaign) ?? {}
  const strategy = obj(typed.BiddingStrategy)
  const budget = obj(c.DailyBudget)
  const options: Record<string, string> = {}
  for (const entry of items(typed.Settings)) {
    const e = obj(entry)
    const option = str(e?.Option)
    const value = str(e?.Value)
    if (option && value) options[option] = value
  }
  return {
    timeZone: str(c.TimeZone),
    currency: str(c.Currency),
    endDate: str(c.EndDate),
    dailyBudget: budget ? { amount: microsOrNull(budget.Amount), mode: str(budget.Mode) } : null,
    negativeKeywords: strings(c.NegativeKeywords),
    negativeKeywordSharedSetIds: ids(typed.NegativeKeywordSharedSetIds),
    counterIds: ids(typed.CounterIds),
    strategy: { search: strategySide(strategy?.Search), network: strategySide(strategy?.Network) },
    options,
  }
}

export type AdGroupRow = {
  id: number | null
  campaignId: number | null
  name: string
  status: string | null
  servingStatus: string | null
  type: string | null
  regionIds: number[]
}

export type KeywordRow = {
  id: number | null
  adGroupId: number | null
  campaignId: number | null
  keyword: string
  isAutotargeting: boolean
  state: string | null
  status: string | null
  servingStatus: string | null
  /** Rubles. null = Direct returned none (bid-less strategy). */
  bid: number | null
  contextBid: number | null
  strategyPriority: string | null
  /** Only for the autotargeting pseudo-keyword. */
  autotargeting?: {
    searchBidIsAuto: string | null
    categories: { category: string; value: string }[]
    brandOptions: { option: string; value: string }[]
  }
}

export type NegativeKeywords = {
  campaign: string[]
  campaignSharedSetIds: number[]
  adGroups: { adGroupId: number | null; phrases: string[]; sharedSetIds: number[] }[]
}

export type DirectStructure = {
  adGroups: AdGroupRow[]
  keywords: { items: KeywordRow[]; truncated: boolean }
  /** Where a phrase is already excluded: the campaign, or one ad group (shared sets: ids only). */
  negativeKeywords: NegativeKeywords
}

export const AUTOTARGETING_KEYWORD = '---autotargeting'

export const ADGROUP_FIELDS = ['Id', 'CampaignId', 'Name', 'Status', 'ServingStatus', 'Type', 'RegionIds', 'NegativeKeywords', 'NegativeKeywordSharedSetIds']
export const KEYWORD_FIELDS = [
  'Id', 'AdGroupId', 'CampaignId', 'Keyword', 'State', 'Status', 'ServingStatus', 'Bid', 'ContextBid', 'StrategyPriority',
  'AutotargetingSearchBidIsAuto', 'AutotargetingCategories', 'AutotargetingBrandOptions',
]

export function normalizeAdGroups(raw: unknown[]): AdGroupRow[] {
  return raw
    .map(obj)
    .filter((g): g is Json => g !== null)
    .map((g) => ({
      id: idOrNull(g.Id),
      campaignId: idOrNull(g.CampaignId),
      name: str(g.Name) ?? '',
      status: str(g.Status),
      servingStatus: str(g.ServingStatus),
      type: str(g.Type),
      regionIds: ids(g.RegionIds),
    }))
}

export function normalizeKeywords(raw: unknown[]): KeywordRow[] {
  return raw
    .map(obj)
    .filter((k): k is Json => k !== null)
    .map((k) => {
      const keyword = str(k.Keyword) ?? ''
      const row: KeywordRow = {
        id: idOrNull(k.Id),
        adGroupId: idOrNull(k.AdGroupId),
        campaignId: idOrNull(k.CampaignId),
        keyword,
        isAutotargeting: keyword === AUTOTARGETING_KEYWORD,
        state: str(k.State),
        status: str(k.Status),
        servingStatus: str(k.ServingStatus),
        bid: microsOrNull(k.Bid),
        contextBid: microsOrNull(k.ContextBid),
        strategyPriority: str(k.StrategyPriority),
      }
      if (row.isAutotargeting) {
        row.autotargeting = {
          searchBidIsAuto: str(k.AutotargetingSearchBidIsAuto),
          categories: items(k.AutotargetingCategories).flatMap((c) => {
            const e = obj(c)
            const category = str(e?.Category)
            const value = str(e?.Value)
            return category && value ? [{ category, value }] : []
          }),
          brandOptions: items(k.AutotargetingBrandOptions).flatMap((o) => {
            const e = obj(o)
            const option = str(e?.Option)
            const value = str(e?.Value)
            return option && value ? [{ option, value }] : []
          }),
        }
      }
      return row
    })
}

/** Negative keywords of the campaign and of every ad group, taken from the raw Direct answers. */
export function normalizeNegativeKeywords(settings: CampaignSettings, rawAdGroups: unknown[]): NegativeKeywords {
  return {
    campaign: settings.negativeKeywords,
    campaignSharedSetIds: settings.negativeKeywordSharedSetIds,
    adGroups: rawAdGroups
      .map(obj)
      .filter((g): g is Json => g !== null)
      .map((g) => ({ adGroupId: idOrNull(g.Id), phrases: strings(g.NegativeKeywords), sharedSetIds: ids(g.NegativeKeywordSharedSetIds) }))
      .filter((g) => g.phrases.length > 0 || g.sharedSetIds.length > 0),
  }
}
