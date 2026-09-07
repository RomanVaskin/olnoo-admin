import type { Pool } from 'pg'
import { callAiRouter } from './ai-router.ts'

export class ClusteringError extends Error {}

export type ClusterKeywordInput = { id: number; query: string; frequency: number | null }
export type ClusterPageInput = {
  id: number
  url: string
  title: string | null
  h1: string | null
  description: string | null
  locale: string | null
}

type Intent = 'commercial' | 'informational' | 'navigational' | 'mixed'

type RawCluster = {
  name: string
  primaryKeyword: string
  keywords: string[]
  intent: Intent
  totalFrequency: number
  recommendedPageUrl: string | null
  confidence: number
  needsNewPage: boolean
  excludeFromSeo: boolean
  reason: string
}

export type ReviewStatus = 'pending' | 'confirmed' | 'no_page' | 'ignored'

export type SavedCluster = {
  id: number
  name: string
  primaryKeywordId: number | null
  primaryKeyword: string | null
  intent: Intent
  totalFrequency: number
  recommendedPageId: number | null
  recommendedPageUrl: string | null
  confidence: number
  needsNewPage: boolean
  reason: string | null
  status: string
  confirmedPageId: number | null
  confirmedPageUrl: string | null
  reviewStatus: ReviewStatus
  reviewedAt: string | null
  keywords: { id: number; query: string; frequency: number | null }[]
}

// MVP: cluster the whole project in a single AI Router call — no batching/merge. The
// Router rejects any message content over 32000 chars; this leaves a small safety margin
// so projects near the edge (many keywords and/or many pages) fail the size check below
// rather than hit the Router's 400 VALIDATION_ERROR.
const MAX_PROMPT_CHARS = 90000

// Below this confidence a cluster is surfaced for manual review instead of being
// auto-labelled "Existing page" / "No page".
const REVIEW_CONFIDENCE_THRESHOLD = 50

const CLUSTERING_SYSTEM_PROMPT = `You are an SEO strategist performing semantic keyword clustering for search intent.

Group the given Wordstat search queries into clusters strictly by REAL SEARCH INTENT — what the searcher actually wants to find or do — never by shared words or surface similarity alone.

Hard rules:
1. One cluster = one search intent = one potential landing page. Never split a single intent into several clusters just because the keywords are worded differently — word forms, synonyms, word order, and filler words (e.g. "компания", "услуги", "цена", "купить", "заказать") do NOT create a new intent on their own.
2. The reverse is equally important: sharing a broad generic phrase does NOT mean the same intent. A phrase like "автоматизация бизнеса" ("business automation") can appear across many genuinely different intents — do not dump most of the keyword set into one giant catch-all cluster just because they share that phrase. When a query adds a qualifier that changes what the searcher actually wants, it is a different intent and belongs in a different cluster. Always keep at least these apart when present, even though they may share the base phrase: general/broad business automation; AI-specific automation (ИИ/AI/агенты/нейросети); sales automation (продажи/отдел продаж); CRM automation; 1C automation (1С); Telegram bots/chatbots (Telegram/чат-бот/бот); education/informational queries (обучение/курс/что такое/книга/статья); local or city-specific queries (a city name like Краснодар, Челябинск, Ростов, Сочи); and brand/navigational queries (a specific company, product, tool, or person's name). A single oversized cluster covering most of the input is almost always wrong — prefer more, narrower clusters over one broad one.
3. Do not create a separate cluster for a synonym or grammatical variant of a keyword already covered by another cluster.
4. Every keyword you are given must end up in exactly one cluster, unless it is genuinely unrelated to every other query — in that case give it its own single-keyword cluster. Never place the same keyword text in more than one cluster's "keywords" array — each keyword belongs to exactly one cluster.
5. Classify each cluster's "intent" as one of: "commercial" (wants to buy/order/hire/get a quote), "informational" (wants to learn/understand), "navigational" (looking for a specific brand/site), or "mixed" (genuinely ambiguous).
6. Pick one "primaryKeyword" per cluster — the most representative query, normally the one with the highest frequency, in clean natural form.
7. Set "totalFrequency" to the sum of the frequency of every keyword you placed in that cluster.
8. You are also given the project's EXISTING PAGES (url, title, h1, locale). If — and only if — one of those pages is a genuine, accurate topical match for the cluster's intent, set "recommendedPageUrl" to that page's exact url from the list. Do not force a loose or partial match just to fill the field. In particular, never recommend a generic non-topical page such as an About page, a Contact page, or a Cases/portfolio page as the target for a cluster — those only match a cluster whose real intent is genuinely about the company itself, contacting it, or its case studies, not as a filler when nothing else fits.
9. If no existing page is a genuinely good match, set "recommendedPageUrl" to null and "needsNewPage" to true.
10. If you recommend an existing page, set "needsNewPage" to false.
11. If every keyword in a cluster is a navigational search for a specific third-party brand, product, tool, or person's name that is NOT this project's own site (e.g. a competitor company, a SaaS/software product, a course, an influencer), this is not an SEO opportunity for this project. Set "intent" to "navigational", set "excludeFromSeo" to true, set "recommendedPageUrl" to null, and set "needsNewPage" to false — do not turn a competitor's or third party's brand query into a task to build a new page. For every other cluster, set "excludeFromSeo" to false.
12. "confidence" is an integer 0-100 expressing confidence in both the clustering and the page recommendation (or the needs-new-page/excludeFromSeo call).
13. "reason" is one short sentence, in the same language as the keywords, explaining the page recommendation, why a new page is needed, or why the cluster was excluded.
14. Never invent a keyword you were not given. Only echo back keywords exactly as given (trimming whitespace is fine).
15. Return ONLY strict JSON — no markdown, no code fences, no commentary before or after. The raw response is parsed as JSON directly.

Output JSON shape, exactly:
{
  "clusters": [
    {
      "name": string,
      "primaryKeyword": string,
      "keywords": string[],
      "intent": "commercial" | "informational" | "navigational" | "mixed",
      "totalFrequency": number,
      "recommendedPageUrl": string | null,
      "confidence": number,
      "needsNewPage": boolean,
      "excludeFromSeo": boolean,
      "reason": string
    }
  ]
}`

function formatKeywordsForPrompt(keywords: ClusterKeywordInput[]): string {
  return keywords.map((k) => `- ${k.query} (frequency: ${k.frequency ?? 0})`).join('\n')
}

function formatPagesForPrompt(pages: ClusterPageInput[]): string {
  if (pages.length === 0) return '(this project has no existing pages yet)'
  return pages
    .map((p) => {
      const bits = [p.url]
      if (p.locale) bits.push(`locale: ${p.locale}`)
      if (p.title) bits.push(`title: ${p.title}`)
      if (p.h1) bits.push(`h1: ${p.h1}`)
      return `- ${bits.join(' | ')}`
    })
    .join('\n')
}

function buildClusteringUserPrompt(keywords: ClusterKeywordInput[], pages: ClusterPageInput[]): string {
  return `KEYWORDS (${keywords.length}):
${formatKeywordsForPrompt(keywords)}

EXISTING PAGES (${pages.length}):
${formatPagesForPrompt(pages)}

Cluster the keywords above by search intent and return the JSON described in your instructions.`
}

function stripToJson(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  }
  return t.trim()
}

function parseClusterResponse(raw: string): RawCluster[] {
  const text = stripToJson(raw)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new ClusteringError('AI Router returned a response that is not valid JSON.')
    }
    try {
      data = JSON.parse(text.slice(start, end + 1))
    } catch {
      throw new ClusteringError('AI Router returned a response that is not valid JSON.')
    }
  }

  if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).clusters)) {
    throw new ClusteringError('AI Router response is missing a "clusters" array.')
  }

  const intents: Intent[] = ['commercial', 'informational', 'navigational', 'mixed']
  const result: RawCluster[] = []

  for (const entry of (data as { clusters: unknown[] }).clusters) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>

    const name = typeof obj.name === 'string' ? obj.name.trim() : ''
    const keywords = Array.isArray(obj.keywords)
      ? obj.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map((k) => k.trim())
      : []
    if (!name || keywords.length === 0) continue

    const primaryKeyword = typeof obj.primaryKeyword === 'string' && obj.primaryKeyword.trim() ? obj.primaryKeyword.trim() : keywords[0]
    const intentRaw = typeof obj.intent === 'string' ? (obj.intent.toLowerCase() as Intent) : 'mixed'
    const intent = intents.includes(intentRaw) ? intentRaw : 'mixed'
    const totalFrequency = typeof obj.totalFrequency === 'number' && Number.isFinite(obj.totalFrequency) ? obj.totalFrequency : 0
    const recommendedPageUrl =
      typeof obj.recommendedPageUrl === 'string' && obj.recommendedPageUrl.trim() ? obj.recommendedPageUrl.trim() : null
    const confidenceNum = typeof obj.confidence === 'number' ? obj.confidence : Number(obj.confidence)
    const confidence = Number.isFinite(confidenceNum) ? Math.max(0, Math.min(100, Math.round(confidenceNum))) : 0
    const needsNewPage = typeof obj.needsNewPage === 'boolean' ? obj.needsNewPage : recommendedPageUrl === null
    const excludeFromSeo = typeof obj.excludeFromSeo === 'boolean' ? obj.excludeFromSeo : false
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : ''

    result.push({
      name,
      primaryKeyword,
      keywords,
      intent,
      totalFrequency,
      recommendedPageUrl,
      confidence,
      needsNewPage,
      excludeFromSeo,
      reason,
    })
  }

  return result
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizePageUrl(url: string): string {
  try {
    const u = new URL(url)
    return (u.pathname.replace(/\/+$/, '') || '/').toLowerCase()
  } catch {
    return url.trim().replace(/\/+$/, '').toLowerCase()
  }
}

// Generic utility pages that are never a genuine SEO target for a keyword cluster — the AI
// is told the same thing in the prompt, but a small set of well-known offenders (contact/case
// study/about pages used as filler recommendations) is rejected here deterministically too.
const NON_SEO_PAGE_LAST_SEGMENTS = new Set(['contact', 'cases', 'about'])

function isNonSeoUtilityPage(pageUrl: string): boolean {
  const path = normalizePageUrl(pageUrl)
  const lastSegment = path.split('/').filter(Boolean).pop() ?? ''
  return NON_SEO_PAGE_LAST_SEGMENTS.has(lastSegment)
}

/**
 * Drops hallucinated keywords/pages, recomputes frequency from real data, derives a UI status,
 * and enforces that every keyword id is claimed by at most one cluster — `usedKeywordIds` is
 * shared across all clusters in a run and mutated in place, so whichever cluster claims a
 * keyword first (AI response order) keeps it and every later duplicate is dropped.
 */
function reconcileCluster(
  raw: RawCluster,
  keywordByQuery: Map<string, ClusterKeywordInput[]>,
  pageByUrl: Map<string, ClusterPageInput>,
  usedKeywordIds: Set<number>,
): {
  name: string
  primaryKeywordId: number | null
  intent: Intent
  totalFrequency: number
  recommendedPageId: number | null
  confidence: number
  needsNewPage: boolean
  reason: string
  status: string
  keywordIds: number[]
} | null {
  // A single keyword TEXT can exist as several DB rows (one per Wordstat region) —
  // every row sharing text the model placed in this cluster belongs in it — but a keyword id
  // already claimed by an earlier cluster in this run is skipped, never assigned twice.
  const matched: ClusterKeywordInput[] = []
  const seen = new Set<number>()
  for (const q of raw.keywords) {
    for (const kw of keywordByQuery.get(normalizeQuery(q)) ?? []) {
      if (!seen.has(kw.id) && !usedKeywordIds.has(kw.id)) {
        seen.add(kw.id)
        matched.push(kw)
      }
    }
  }
  if (matched.length === 0) return null
  for (const kw of matched) usedKeywordIds.add(kw.id)

  const totalFrequency = matched.reduce((sum, k) => sum + (k.frequency ?? 0), 0)

  const primaryCandidates = keywordByQuery.get(normalizeQuery(raw.primaryKeyword))?.filter((k) => seen.has(k.id))
  let primary =
    primaryCandidates && primaryCandidates.length > 0
      ? primaryCandidates.reduce((best, k) => ((k.frequency ?? 0) > (best.frequency ?? 0) ? k : best), primaryCandidates[0])
      : matched.reduce((best, k) => ((k.frequency ?? 0) > (best.frequency ?? 0) ? k : best), matched[0])

  let recommendedPage = raw.recommendedPageUrl ? pageByUrl.get(normalizePageUrl(raw.recommendedPageUrl)) ?? null : null
  if (recommendedPage && isNonSeoUtilityPage(recommendedPage.url)) recommendedPage = null

  // Competitor/brand navigational queries are not an OLNOO SEO opportunity — never a page
  // recommendation, never a "build a new page" task, regardless of what the AI set.
  const needsNewPage = raw.excludeFromSeo ? false : recommendedPage ? false : true

  const status = raw.excludeFromSeo
    ? 'Ignored'
    : raw.confidence < REVIEW_CONFIDENCE_THRESHOLD
      ? 'Needs review'
      : recommendedPage
        ? 'Existing page'
        : 'No page'

  return {
    name: raw.name,
    primaryKeywordId: primary?.id ?? null,
    intent: raw.intent,
    totalFrequency,
    recommendedPageId: raw.excludeFromSeo ? null : (recommendedPage?.id ?? null),
    confidence: raw.confidence,
    needsNewPage,
    reason: raw.reason,
    status,
    keywordIds: matched.map((k) => k.id),
  }
}

async function persistClusters(
  pool: Pool,
  projectId: number,
  clusters: ReturnType<typeof reconcileCluster>[],
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Regenerating replaces the previous AI-generated set outright — the simplest way to
    // guarantee repeated runs never accumulate duplicates. Manual keyword_pages mapping
    // (SEO Map) is untouched.
    await client.query('DELETE FROM seo_clusters WHERE project_id = $1', [projectId])

    for (const c of clusters) {
      if (!c) continue
      const { rows } = await client.query(
        `INSERT INTO seo_clusters
          (project_id, name, primary_keyword_id, intent, total_frequency, recommended_page_id, confidence, needs_new_page, reason, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          projectId,
          c.name,
          c.primaryKeywordId,
          c.intent,
          c.totalFrequency,
          c.recommendedPageId,
          c.confidence,
          c.needsNewPage,
          c.reason,
          c.status,
        ],
      )
      const clusterId = rows[0].id
      for (const keywordId of c.keywordIds) {
        await client.query(
          `INSERT INTO seo_cluster_keywords (cluster_id, keyword_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [clusterId, keywordId],
        )
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Fetches a project's keywords + pages, clusters them via the AI Router, validates the result, and saves it. */
export async function generateClustersForProject(pool: Pool, projectId: number): Promise<void> {
  const { rows: keywordRows } = await pool.query(
    `SELECT id, query, frequency FROM keywords WHERE project_id = $1 ORDER BY frequency DESC NULLS LAST, id ASC`,
    [projectId],
  )
  if (keywordRows.length === 0) {
    throw new ClusteringError('This project has no keywords to cluster yet — import Wordstat data first.')
  }

  const { rows: pageRows } = await pool.query(
    `SELECT id, url, title, h1, description, locale FROM pages WHERE project_id = $1 ORDER BY url ASC`,
    [projectId],
  )

  const keywords: ClusterKeywordInput[] = keywordRows.map((r) => ({
    id: r.id,
    query: r.query,
    frequency: r.frequency,
  }))
  const pages: ClusterPageInput[] = pageRows

  const userPrompt = buildClusteringUserPrompt(keywords, pages)
  if (userPrompt.length > MAX_PROMPT_CHARS) {
    throw new ClusteringError('Too many keywords for clustering in one run')
  }

  const content = await callAiRouter([
    { role: 'system', content: CLUSTERING_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ])
  const finalRaw = parseClusterResponse(content)

  const keywordByQuery = new Map<string, ClusterKeywordInput[]>()
  for (const k of keywords) {
    const key = normalizeQuery(k.query)
    const list = keywordByQuery.get(key) ?? []
    list.push(k)
    keywordByQuery.set(key, list)
  }
  const pageByUrl = new Map(pages.map((p) => [normalizePageUrl(p.url), p]))

  // Shared across every reconcileCluster() call below so a keyword the AI placed in more than
  // one cluster is kept only in the first (its best/most-confident placement per the prompt's
  // response order) and dropped from every later duplicate — no keyword id is ever saved twice.
  const usedKeywordIds = new Set<number>()
  const reconciled = finalRaw
    .map((c) => reconcileCluster(c, keywordByQuery, pageByUrl, usedKeywordIds))
    .filter((c): c is NonNullable<typeof c> => c !== null)

  if (reconciled.length === 0) {
    throw new ClusteringError('AI Router did not return any usable clusters for this project.')
  }

  // Defensive invariant: by construction usedKeywordIds can never exceed the project's own
  // keyword count, but this guards against a future edit silently breaking that guarantee.
  const totalClusteredKeywords = reconciled.reduce((sum, c) => sum + c.keywordIds.length, 0)
  if (totalClusteredKeywords !== usedKeywordIds.size || usedKeywordIds.size > keywords.length) {
    throw new ClusteringError('Clustering validation failed: keyword counts do not reconcile with the project.')
  }

  await persistClusters(pool, projectId, reconciled)
}

/** Loads the saved clusters for a project, with keyword and page details joined in for the UI. */
export async function listClustersForProject(pool: Pool, projectId: number): Promise<SavedCluster[]> {
  const { rows: clusterRows } = await pool.query(
    `
    SELECT
      sc.id,
      sc.name,
      sc.primary_keyword_id,
      pk.query AS primary_keyword,
      sc.intent,
      sc.total_frequency,
      sc.recommended_page_id,
      rp.url AS recommended_page_url,
      sc.confidence,
      sc.needs_new_page,
      sc.reason,
      sc.status,
      sc.confirmed_page_id,
      cp.url AS confirmed_page_url,
      sc.review_status,
      sc.reviewed_at
    FROM seo_clusters sc
    LEFT JOIN keywords pk ON pk.id = sc.primary_keyword_id
    LEFT JOIN pages rp ON rp.id = sc.recommended_page_id
    LEFT JOIN pages cp ON cp.id = sc.confirmed_page_id
    WHERE sc.project_id = $1
    ORDER BY sc.total_frequency DESC NULLS LAST, sc.id ASC
    `,
    [projectId],
  )

  if (clusterRows.length === 0) return []

  const { rows: keywordRows } = await pool.query(
    `
    SELECT sck.cluster_id, k.id, k.query, k.frequency
    FROM seo_cluster_keywords sck
    JOIN keywords k ON k.id = sck.keyword_id
    WHERE sck.cluster_id = ANY($1::int[])
    ORDER BY k.frequency DESC NULLS LAST, k.query ASC
    `,
    [clusterRows.map((r) => r.id)],
  )

  const keywordsByCluster = new Map<number, { id: number; query: string; frequency: number | null }[]>()
  for (const row of keywordRows) {
    const list = keywordsByCluster.get(row.cluster_id) ?? []
    list.push({ id: row.id, query: row.query, frequency: row.frequency })
    keywordsByCluster.set(row.cluster_id, list)
  }

  return clusterRows.map((r) => ({
    id: r.id,
    name: r.name,
    primaryKeywordId: r.primary_keyword_id,
    primaryKeyword: r.primary_keyword,
    intent: r.intent,
    totalFrequency: r.total_frequency,
    recommendedPageId: r.recommended_page_id,
    recommendedPageUrl: r.recommended_page_url,
    confidence: r.confidence,
    needsNewPage: r.needs_new_page,
    reason: r.reason,
    status: r.status,
    confirmedPageId: r.confirmed_page_id,
    confirmedPageUrl: r.confirmed_page_url,
    reviewStatus: r.review_status,
    reviewedAt: r.reviewed_at,
    keywords: keywordsByCluster.get(r.id) ?? [],
  }))
}

export class ClusterReviewError extends Error {}

/**
 * Records a human decision on a cluster's target page — separate from the AI's own
 * `status` field, which stays untouched and keeps reflecting the AI's own classification.
 * 'confirmed' requires a pageId (the AI recommendation or another existing page from the
 * same project); 'no_page' and 'ignored' always clear confirmed_page_id.
 */
export async function updateClusterReview(
  pool: Pool,
  params: { clusterId: number; projectId: number; reviewStatus: ReviewStatus; pageId: number | null },
): Promise<void> {
  const { clusterId, projectId, reviewStatus, pageId } = params

  if (reviewStatus === 'confirmed') {
    if (!Number.isInteger(pageId)) {
      throw new ClusterReviewError('pageId is required to confirm a target page.')
    }
    const { rows } = await pool.query(
      `UPDATE seo_clusters
       SET confirmed_page_id = $1, review_status = 'confirmed', reviewed_at = now(), updated_at = now()
       WHERE id = $2
         AND project_id = $3
         AND EXISTS (SELECT 1 FROM pages p WHERE p.id = $1 AND p.project_id = $3)
       RETURNING id`,
      [pageId, clusterId, projectId],
    )
    if (rows.length === 0) {
      throw new ClusterReviewError('Cluster or page not found for this project.')
    }
    return
  }

  if (reviewStatus !== 'no_page' && reviewStatus !== 'ignored') {
    throw new ClusterReviewError('Invalid review status.')
  }

  const { rows } = await pool.query(
    `UPDATE seo_clusters
     SET confirmed_page_id = NULL, review_status = $1, reviewed_at = now(), updated_at = now()
     WHERE id = $2 AND project_id = $3
     RETURNING id`,
    [reviewStatus, clusterId, projectId],
  )
  if (rows.length === 0) {
    throw new ClusterReviewError('Cluster not found for this project.')
  }
}
