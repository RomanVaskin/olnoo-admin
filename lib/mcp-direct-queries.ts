// Direct MCP Eyes v1: whitelist DTO for the read-only MCP tool `get_direct_queries` — the top DriveSet search queries by spend
// plus the CURRENT negative keywords, built from the existing Direct Observer payload (no new Direct client, no new API).
// Pure module (no `@/` imports): runs under `node --test`. The route fetches the payload; this file only maps it (access is OAuth, see lib/mcp-oauth.ts).

import { AUTOTARGETING_KEYWORD, type ObserverPayload } from './yandex-direct-report.ts'

export const QUERIES_TOOL_NAME = 'get_direct_queries'
export const QUERIES_TOOL_DESCRIPTION =
  'Read-only DriveSet Yandex Direct search queries: the top 50 by spend for the period (query, criteria, criteriaType, adGroupId, impressions, clicks, spend, CPC, autotargeting flag) ' +
  'and the current campaign / ad-group negative keywords, for manual analysis of negative-keyword candidates. Moscow calendar days; Direct current-day numbers are partial. ' +
  'Aggregated Direct data only: it says nothing about which CRM lead a query produced. It proposes nothing and changes nothing.'
export const TOP_QUERIES_LIMIT = 50

export type QueryRowDto = {
  query: string
  criteria: string
  criteriaType: string
  adGroupId: number | null
  impressions: number
  clicks: number
  spend: number
  cpc: number | null
  isAutotargeting: boolean
}

export type DirectQueriesDto = {
  period: { from: string; to: string; complete: boolean; preset: string }
  campaignId: number
  /** Queries Direct returned for the period (before the top-N cut). */
  totalQueries: number
  /** true when `queries` is cut to the top N by spend. */
  truncated: boolean
  queries: QueryRowDto[]
  /** Phrases exactly as Direct stores them. `complete` is false when the ad-group list hit the page cap (group phrases may be missing). */
  negativeKeywords: {
    complete: boolean
    campaign: string[]
    campaignSharedSetIds: number[]
    adGroups: { adGroupId: number | null; phrases: string[]; sharedSetIds: number[] }[]
  }
  generatedAt: string
}

const num = (v: unknown, fallback: number | null): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * Direct Observer payload (read with `structure: true`) → DTO. Every field is copied by name: the optional deprecated
 * `targetingCategory`, campaign settings, bids, keywords and request ids never reach the client. A missing structure gives
 * `negativeKeywords.complete = false` and empty lists (never "nothing is excluded").
 */
export function toQueriesDto(
  payload: Pick<ObserverPayload, 'period' | 'campaign' | 'searchQueries' | 'structure'>,
  period: { complete: boolean; preset: string },
  now: Date,
  limit: number = TOP_QUERIES_LIMIT,
): DirectQueriesDto {
  const sorted = [...payload.searchQueries].sort((a, b) => b.spend - a.spend || b.clicks - a.clicks || a.query.localeCompare(b.query))
  const queries = sorted.slice(0, limit).map((q) => ({
    query: q.query,
    criteria: q.criteria,
    criteriaType: q.criteriaType,
    adGroupId: num(q.adGroupId, null),
    impressions: num(q.impressions, 0) as number,
    clicks: num(q.clicks, 0) as number,
    spend: num(q.spend, 0) as number,
    cpc: num(q.cpc, null),
    isAutotargeting: q.criteriaType === 'AUTOTARGETING' || q.criteria === AUTOTARGETING_KEYWORD,
  }))
  const neg = payload.structure?.negativeKeywords
  return {
    period: { from: payload.period.from, to: payload.period.to, complete: period.complete, preset: period.preset },
    campaignId: payload.campaign.id,
    totalQueries: sorted.length,
    truncated: sorted.length > limit,
    queries,
    negativeKeywords: {
      complete: !!payload.structure && !payload.structure.adGroupsTruncated,
      campaign: neg ? [...neg.campaign] : [],
      campaignSharedSetIds: neg ? [...neg.campaignSharedSetIds] : [],
      adGroups: neg ? neg.adGroups.map((g) => ({ adGroupId: g.adGroupId, phrases: [...g.phrases], sharedSetIds: [...g.sharedSetIds] })) : [],
    },
    generatedAt: now.toISOString(),
  }
}
