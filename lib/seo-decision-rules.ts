// SEO Decision rules v1 (roadmap step D): a PURE deterministic function. No DB, no fetch, no env, no AI, no clock — every input is
// passed in. It only PROPOSES; nothing is stored (no opportunity / decision table), nothing is written, nothing is executed.
//
// Strict priority:  FIX → IGNORE → IMPROVE → CREATE_CANDIDATE → NONE
//
// Query ↔ page: Webmaster queries carry NO URL. The only link used here is semantic OWNERSHIP decided by a human:
//   Webmaster query → exact normalised match with a keyword of a human-confirmed cluster → that cluster's confirmed_page_id.
// It is not attribution ("this query led to this page") and nothing here claims it. No fuzzy matching, stemming or embeddings.
// Metrika organic visits are separate page-level evidence (exact URL) and never feed the query matching.

export type DecisionAction = 'FIX' | 'IGNORE' | 'IMPROVE' | 'CREATE_CANDIDATE' | 'NONE'

/** Starting values of v1, NOT truth: to be calibrated on real snapshots. Code constants (no Settings UI, no DB). */
export const SEO_DECISION_THRESHOLDS = {
  minImpressions: 10,
  improvePositionMin: 8,
  improvePositionMax: 30,
} as const

/** Technical SEO issues that block a whole project: FIX wins over every cluster decision of the project. */
export const PROJECT_BLOCKING_CODES: ReadonlySet<string> = new Set(['site_unavailable', 'robots_disallow_all', 'sitemap_missing', 'sitemap_unreadable', 'check_failed'])
/** Issues that block ONE page (matched by URL): FIX for that page only; other pages are decided normally. */
export const PAGE_BLOCKING_CODES: ReadonlySet<string> = new Set(['page_unreachable', 'page_http_error', 'noindex_in_sitemap'])
// Every other code (canonical_*, title_missing, h1_missing, page_redirect, robots_missing, …) is a Technical SEO fix too, but it does not block.

export type DecisionIssue = { code: string; url?: string | null }
export type DecisionQueryRow = { query: string; impressions: number; clicks: number; avgPosition: number | null }
export type DecisionOrganicPage = { url: string; visits: number }
export type DecisionPage = { id: number; url: string }
export type DecisionKeyword = { query: string; /** keywords.relevance_status; null / undefined = unknown */ relevanceStatus?: string | null }
export type DecisionCluster = {
  id: number
  name: string
  intent: string | null
  reviewStatus: 'pending' | 'confirmed' | 'no_page' | 'ignored'
  confirmedPageId: number | null
  keywords: DecisionKeyword[]
}

export type DecisionInput = {
  projectId: number
  /** The latest saved Technical SEO result (issues only); null = never checked. */
  technicalIssues: DecisionIssue[] | null
  /** Latest yandex_webmaster / queries rows; null = no snapshot. */
  webmasterQueries: DecisionQueryRow[] | null
  /** Latest yandex_metrika / organic_pages rows; null = no snapshot. */
  organicPages: DecisionOrganicPage[] | null
  clusters: DecisionCluster[]
  pages: DecisionPage[]
  thresholds?: typeof SEO_DECISION_THRESHOLDS
}

export type DecisionEvidence = {
  impressions?: number
  clicks?: number
  ctr?: number | null
  avgPosition?: number | null
  issueCodes?: string[]
  /** Distinct exact-matched Webmaster queries behind the numbers. */
  matchedQueries?: number
  /** Metrika organic visits of the page (exact URL) — separate evidence, not query attribution. */
  organicVisits?: number
  clusterIds?: number[]
}

export type SeoDecision = {
  action: DecisionAction
  projectId: number
  clusterId?: number
  pageId?: number
  pageUrl?: string
  clusterName?: string
  reason: string
  evidence: DecisionEvidence
}

// ---- helpers ---------------------------------------------------------------------------------------------------------

/** trim, lowercase, collapse whitespace, ё → е. Exact match after this — nothing else (no stemming, no fuzzy, no LLM). */
export function normalizeDecisionQuery(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')
}

/** Exact URL comparison key: lowercase scheme/host, no hash, no trailing slash (except the root). */
export function normalizeDecisionUrl(value: string): string | null {
  try {
    const u = new URL(value)
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : ''
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`
  } catch {
    return null
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100
const IRRELEVANT = new Set(['irrelevant', 'geo_mismatch', 'uncertain'])

type Totals = { impressions: number; clicks: number; positionWeighted: number; positionImpressions: number; queries: number }

function emptyTotals(): Totals {
  return { impressions: 0, clicks: 0, positionWeighted: 0, positionImpressions: 0, queries: 0 }
}
function addRow(t: Totals, r: DecisionQueryRow) {
  t.impressions += r.impressions
  t.clicks += r.clicks
  if (r.avgPosition !== null && r.impressions > 0) {
    t.positionWeighted += r.avgPosition * r.impressions
    t.positionImpressions += r.impressions
  }
  t.queries++
}
/** impressions / clicks summed; position weighted by impressions (null without impressions); CTR = clicks / impressions * 100 from the sums. */
function finish(t: Totals): { impressions: number; clicks: number; ctr: number | null; avgPosition: number | null; matchedQueries: number } {
  return {
    impressions: t.impressions,
    clicks: t.clicks,
    ctr: t.impressions > 0 ? round2((t.clicks / t.impressions) * 100) : null,
    avgPosition: t.positionImpressions > 0 ? round2(t.positionWeighted / t.positionImpressions) : null,
    matchedQueries: t.queries,
  }
}

/** Webmaster rows merged by normalised query (two spellings of one query are one query), skipping malformed rows. */
function indexQueries(rows: DecisionQueryRow[]): Map<string, DecisionQueryRow> {
  const map = new Map<string, DecisionQueryRow>()
  for (const r of rows) {
    if (typeof r?.query !== 'string' || !Number.isFinite(r.impressions) || r.impressions < 0) continue
    const key = normalizeDecisionQuery(r.query)
    if (!key) continue
    const clicks = Number.isFinite(r.clicks) ? r.clicks : 0
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { query: key, impressions: r.impressions, clicks, avgPosition: r.avgPosition })
    } else {
      const w = prev.impressions + r.impressions
      const pos = prev.avgPosition !== null && r.avgPosition !== null && w > 0 ? (prev.avgPosition * prev.impressions + r.avgPosition * r.impressions) / w : (prev.avgPosition ?? r.avgPosition)
      map.set(key, { query: key, impressions: w, clicks: prev.clicks + clicks, avgPosition: pos })
    }
  }
  return map
}

const clusterKeywordSet = (c: DecisionCluster) => new Set(c.keywords.map((k) => normalizeDecisionQuery(k.query)).filter(Boolean))

// ---- the rules -------------------------------------------------------------------------------------------------------

const ORDER: Record<DecisionAction, number> = { FIX: 0, IGNORE: 1, IMPROVE: 2, CREATE_CANDIDATE: 3, NONE: 4 }

export function decideSeoActions(input: DecisionInput): SeoDecision[] {
  const t = input.thresholds ?? SEO_DECISION_THRESHOLDS
  const { projectId } = input
  const out: SeoDecision[] = []
  const issues = input.technicalIssues ?? []

  // 1. FIX — always first. -----------------------------------------------------------------------------------------------
  const projectCodes = [...new Set(issues.filter((i) => PROJECT_BLOCKING_CODES.has(i.code)).map((i) => i.code))].sort()
  const pageByUrl = new Map<string, DecisionPage>()
  for (const p of input.pages) {
    const key = normalizeDecisionUrl(p.url)
    if (key && !pageByUrl.has(key)) pageByUrl.set(key, p)
  }
  const blockedPageKeys = new Set<string>()
  const pageIssues = new Map<string, { url: string; codes: Set<string> }>()
  for (const i of issues) {
    if (!PAGE_BLOCKING_CODES.has(i.code) || !i.url) continue
    const key = normalizeDecisionUrl(i.url) ?? i.url
    blockedPageKeys.add(key)
    const entry = pageIssues.get(key) ?? { url: i.url, codes: new Set<string>() }
    entry.codes.add(i.code)
    pageIssues.set(key, entry)
  }
  if (projectCodes.length) {
    out.push({ action: 'FIX', projectId, reason: 'project_blocking_issue', evidence: { issueCodes: projectCodes } })
  }
  for (const [key, entry] of [...pageIssues].sort((a, b) => a[0].localeCompare(b[0]))) {
    const page = pageByUrl.get(key)
    out.push({ action: 'FIX', projectId, ...(page ? { pageId: page.id } : {}), pageUrl: page?.url ?? entry.url, reason: 'page_blocking_issue', evidence: { issueCodes: [...entry.codes].sort() } })
  }
  // A project-level blocker outranks every cluster decision of the project.
  if (projectCodes.length) return sorted(out)

  // 2. IGNORE. ------------------------------------------------------------------------------------------------------------
  const live: DecisionCluster[] = []
  for (const c of input.clusters) {
    if (c.reviewStatus === 'ignored') {
      out.push({ action: 'IGNORE', projectId, clusterId: c.id, clusterName: c.name, reason: 'human_ignored', evidence: {} })
      continue
    }
    // AI relevance only decides for clusters a human has NOT reviewed: a human decision always outranks it.
    // Unknown (null) relevance is never "ignored", and mixed relevance is not ignored either.
    if (c.reviewStatus === 'pending' && c.keywords.length > 0 && c.keywords.every((k) => k.relevanceStatus != null && IRRELEVANT.has(k.relevanceStatus))) {
      out.push({ action: 'IGNORE', projectId, clusterId: c.id, clusterName: c.name, reason: 'all_keywords_irrelevant', evidence: {} })
      continue
    }
    live.push(c)
  }

  const queries = input.webmasterQueries ? indexQueries(input.webmasterQueries) : null
  const organic = new Map<string, number>()
  for (const p of input.organicPages ?? []) {
    const key = typeof p?.url === 'string' ? normalizeDecisionUrl(p.url) : null
    if (key && Number.isFinite(p.visits)) organic.set(key, (organic.get(key) ?? 0) + p.visits)
  }

  // 3. IMPROVE — ONE decision per confirmed page. ---------------------------------------------------------------------------
  const confirmed = live.filter((c) => c.reviewStatus === 'confirmed' && c.confirmedPageId !== null && c.intent !== 'navigational')
  const byPage = new Map<number, DecisionCluster[]>()
  for (const c of confirmed) byPage.set(c.confirmedPageId!, [...(byPage.get(c.confirmedPageId!) ?? []), c])
  const pageById = new Map(input.pages.map((p) => [p.id, p]))

  for (const [pageId, group] of [...byPage].sort((a, b) => a[0] - b[0])) {
    const page = pageById.get(pageId)
    const pageKey = page ? normalizeDecisionUrl(page.url) : null
    if (pageKey && blockedPageKeys.has(pageKey)) continue // the page has its own FIX
    const clusterIds = group.map((c) => c.id).sort((a, b) => a - b)
    const base = { projectId, pageId, ...(page ? { pageUrl: page.url } : {}) }
    if (!queries) {
      out.push({ action: 'NONE', ...base, reason: 'no_webmaster_snapshot', evidence: { clusterIds } })
      continue
    }
    // each distinct Webmaster query counts ONCE for the page, even if several of its clusters share the keyword
    const totals = emptyTotals()
    const seen = new Set<string>()
    for (const c of group) {
      for (const key of clusterKeywordSet(c)) {
        const row = queries.get(key)
        if (row && !seen.has(key)) {
          seen.add(key)
          addRow(totals, row)
        }
      }
    }
    const m = finish(totals)
    const visits = pageKey ? organic.get(pageKey) : undefined
    const evidence: DecisionEvidence = { impressions: m.impressions, clicks: m.clicks, ctr: m.ctr, avgPosition: m.avgPosition, matchedQueries: m.matchedQueries, clusterIds, ...(visits !== undefined ? { organicVisits: visits } : {}) }
    if (m.impressions < t.minImpressions) out.push({ action: 'NONE', ...base, reason: 'not_enough_impressions', evidence })
    else if (m.avgPosition === null || m.avgPosition < t.improvePositionMin || m.avgPosition > t.improvePositionMax) out.push({ action: 'NONE', ...base, reason: 'position_outside_improve_range', evidence })
    else out.push({ action: 'IMPROVE', ...base, reason: 'confirmed_page_in_improve_range', evidence })
  }

  // 4. CREATE_CANDIDATE — only a human `no_page`. ----------------------------------------------------------------------------
  const ownedKeywords = new Map<string, number>() // normalised keyword → page of a human-confirmed cluster
  for (const c of live.filter((x) => x.reviewStatus === 'confirmed' && x.confirmedPageId !== null)) {
    for (const k of clusterKeywordSet(c)) if (!ownedKeywords.has(k)) ownedKeywords.set(k, c.confirmedPageId!)
  }
  for (const c of live.filter((x) => x.reviewStatus === 'no_page' && x.confirmedPageId === null).sort((a, b) => a.id - b.id)) {
    const base = { projectId, clusterId: c.id, clusterName: c.name }
    if (c.intent === 'navigational') {
      out.push({ action: 'NONE', ...base, reason: 'navigational_intent', evidence: {} })
      continue
    }
    const keys = clusterKeywordSet(c)
    const overlap = [...keys].find((k) => ownedKeywords.has(k))
    if (overlap !== undefined) {
      // one intent = one page: an exact keyword already owned by a confirmed page → no new page
      const owner = pageById.get(ownedKeywords.get(overlap)!)
      out.push({ action: 'NONE', ...base, ...(owner ? { pageId: owner.id, pageUrl: owner.url } : {}), reason: 'possible_existing_page_overlap', evidence: {} })
      continue
    }
    let evidence: DecisionEvidence = {}
    if (queries) {
      const totals = emptyTotals()
      for (const k of keys) {
        const row = queries.get(k)
        if (row) addRow(totals, row)
      }
      const m = finish(totals)
      if (m.matchedQueries > 0) evidence = { impressions: m.impressions, clicks: m.clicks, ctr: m.ctr, avgPosition: m.avgPosition, matchedQueries: m.matchedQueries }
    }
    out.push({ action: 'CREATE_CANDIDATE', ...base, reason: 'human_no_page', evidence })
  }

  return sorted(out)
}

/** FIX, IGNORE, IMPROVE, CREATE_CANDIDATE, NONE — and a stable order inside each group. */
function sorted(list: SeoDecision[]): SeoDecision[] {
  return list
    .map((d, i) => ({ d, i }))
    .sort((a, b) => ORDER[a.d.action] - ORDER[b.d.action] || a.i - b.i)
    .map((x) => x.d)
}
