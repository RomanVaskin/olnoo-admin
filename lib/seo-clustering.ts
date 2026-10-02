import type { Pool, PoolClient } from 'pg'
import { callAiRouter, type AiRouterMessage } from './ai-router.ts'
import { CLUSTERING_KEYWORD_FILTER_SQL } from './keywords-relevance-rules.ts'
import {
  chunk,
  CLUSTER_BATCH_MAX_CHARS,
  CLUSTER_BATCH_SIZE,
  buildMergeUserPrompt,
  MERGE_CHUNK_SIZE,
  MERGE_MAX_PASSES,
  MERGE_ORDERINGS,
  MERGE_SYSTEM_PROMPT,
  normalizeQuery,
  parseMergeResponse,
  planBatches,
  promptLine,
  stemSignature,
  stripToJson,
  UnitGroups,
  type MergeGroup,
  type MergeUnit,
} from './seo-clustering-batch.ts'

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
  return keywords.map(promptLine).join('\n')
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

export type LlmCall = (messages: AiRouterMessage[]) => Promise<string>

export type ClusteringOptions = {
  /** Injected in tests; production uses the AI Router. */
  llm?: LlmCall
  batchSize?: number
  mergeChunkSize?: number
  /** Parallel AI Router calls. */
  concurrency?: number
}

type Unit = MergeUnit & {
  keywordIds: number[]
  confidence: number
  needsNewPage: boolean
  excludeFromSeo: boolean
  reason: string
  /** seo_clusters.id of a human-reviewed cluster (fixed units only). */
  clusterId?: number
}

type BatchState = {
  index: number
  keywordIds: number[]
  status: 'pending' | 'running' | 'done' | 'failed'
  units: Unit[]
  error?: string
  /** Second-chance batch for keywords the AI left out of their first batch. */
  orphan: boolean
}

export type ClusteringJobStatus = 'running' | 'failed' | 'done'
export type ClusteringPhase = 'batches' | 'merge' | 'saving' | 'done'

export type ClusteringResult = {
  excludedByCleanup: number
  keywords: number
  processed: number
  clustersCreated: number
  addedToReviewed: number
  needsReviewKeywords: number
  llmCalls: number
}

/** A clustering run. Lives in server memory (single Node process): survives batch errors, not a restart. */
export type ClusteringJob = {
  id: string
  projectId: number
  status: ClusteringJobStatus
  phase: ClusteringPhase
  totalKeywords: number
  /** Keywords left out of this run by relevance cleanup (irrelevant, other region, unresolved, not yet checked). */
  excludedByCleanup: number
  toCluster: number
  batches: BatchState[]
  mergePass: number
  mergeCallsDone: number
  llmCalls: number
  error: string | null
  result: ClusteringResult | null
  startedAt: string
  updatedAt: string
  // Snapshot taken at start; the run never touches keywords added later.
  keywords: Map<number, ClusterKeywordInput>
  pages: ClusterPageInput[]
  fixedUnits: Unit[]
}

export type ClusteringJobView = {
  id: string
  projectId: number
  status: ClusteringJobStatus
  phase: ClusteringPhase
  totalKeywords: number
  processedKeywords: number
  batchesDone: number
  batchesTotal: number
  failedBatches: number
  mergePass: number
  mergeCallsDone: number
  error: string | null
  result: ClusteringResult | null
}

export function viewClusteringJob(job: ClusteringJob): ClusteringJobView {
  const done = job.batches.filter((b) => b.status === 'done')
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    phase: job.phase,
    totalKeywords: job.totalKeywords,
    processedKeywords: job.totalKeywords - job.toCluster + done.filter((b) => !b.orphan).reduce((n, b) => n + b.keywordIds.length, 0),
    batchesDone: done.length,
    batchesTotal: job.batches.length,
    failedBatches: job.batches.filter((b) => b.status === 'failed').length,
    mergePass: job.mergePass,
    mergeCallsDone: job.mergeCallsDone,
    error: job.error,
    result: job.result,
  }
}

function touch(job: ClusteringJob) {
  job.updatedAt = new Date().toISOString()
}

/**
 * Plans a run: keywords already in a human-reviewed cluster (review_status <> 'pending') keep
 * their cluster and are not re-clustered; every other keyword is split into batches.
 */
export async function createClusteringJob(pool: Pool, projectId: number, opts: ClusteringOptions = {}): Promise<ClusteringJob> {
  // Which keywords take part is decided from their LIVE relevance state right now (see
  // CLUSTERING_KEYWORD_FILTER_SQL): a project without cleanup keeps taking every keyword.
  const { rows: keywordRows } = await pool.query(
    `SELECT k.id, k.query, k.frequency
     FROM keywords k JOIN projects p ON p.id = k.project_id
     WHERE k.project_id = $1 AND ${CLUSTERING_KEYWORD_FILTER_SQL}
     ORDER BY k.frequency DESC NULLS LAST, k.id ASC`,
    [projectId],
  )
  const { rows: countRows } = await pool.query('SELECT count(*)::int AS n FROM keywords WHERE project_id = $1', [projectId])
  const excludedByCleanup = countRows[0].n - keywordRows.length
  if (keywordRows.length === 0) {
    throw new ClusteringError(
      countRows[0].n === 0
        ? 'This project has no keywords to cluster yet — import Wordstat data first.'
        : 'Нет запросов для кластеризации: после очистки запросов ни один не отмечен как целевой или информационный. Проверьте запросы на экране «Очистка запросов».',
    )
  }
  const { rows: pageRows } = await pool.query(
    `SELECT id, url, title, h1, description, locale FROM pages WHERE project_id = $1 ORDER BY url ASC`,
    [projectId],
  )
  const { rows: reviewed } = await pool.query(
    `SELECT sc.id, sc.name, sc.intent, sc.confidence, sc.reason, pk.query AS primary_keyword, rp.url AS page_url,
            COALESCE(array_agg(sck.keyword_id) FILTER (WHERE sck.keyword_id IS NOT NULL), '{}') AS keyword_ids
     FROM seo_clusters sc
     LEFT JOIN seo_cluster_keywords sck ON sck.cluster_id = sc.id
     LEFT JOIN keywords pk ON pk.id = sc.primary_keyword_id
     LEFT JOIN pages rp ON rp.id = COALESCE(sc.confirmed_page_id, sc.recommended_page_id)
     WHERE sc.project_id = $1 AND sc.review_status <> 'pending'
     GROUP BY sc.id, pk.query, rp.url
     ORDER BY sc.id`,
    [projectId],
  )

  const keywords = new Map<number, ClusterKeywordInput>(keywordRows.map((r) => [r.id, { id: r.id, query: r.query, frequency: r.frequency }]))
  const fixedIds = new Set<number>()
  const fixedUnits: Unit[] = reviewed.map((r) => {
    const ids = (r.keyword_ids as number[]).filter((id) => keywords.has(id))
    ids.forEach((id) => fixedIds.add(id))
    const kws = ids.map((id) => keywords.get(id)!)
    return {
      ...unitStats(kws),
      uid: `r${r.id}`,
      clusterId: r.id,
      fixed: true,
      name: r.name,
      intent: (r.intent ?? 'mixed') as Unit['intent'],
      primaryKeyword: r.primary_keyword ?? kws[0]?.query ?? r.name,
      recommendedPageUrl: r.page_url ?? null,
      keywordIds: ids,
      confidence: r.confidence ?? 100,
      needsNewPage: false,
      excludeFromSeo: false,
      reason: r.reason ?? '',
    }
  })

  const toCluster = [...keywords.values()].filter((k) => !fixedIds.has(k.id))
  const batches = planBatches(toCluster, { batchSize: opts.batchSize ?? CLUSTER_BATCH_SIZE, maxChars: CLUSTER_BATCH_MAX_CHARS })
  const now = new Date().toISOString()
  return {
    id: `${projectId}-${Date.now().toString(36)}`,
    projectId,
    status: 'running',
    phase: 'batches',
    totalKeywords: keywords.size,
    excludedByCleanup,
    toCluster: toCluster.length,
    batches: batches.map((b, index) => ({ index, keywordIds: b.map((k) => k.id), status: 'pending', units: [], orphan: false })),
    mergePass: 0,
    mergeCallsDone: 0,
    llmCalls: 0,
    error: null,
    result: null,
    startedAt: now,
    updatedAt: now,
    keywords,
    pages: pageRows,
    fixedUnits,
  }
}

function unitStats(kws: ClusterKeywordInput[]): { totalFrequency: number; topKeywords: string[] } {
  const sorted = [...kws].sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0))
  return {
    totalFrequency: kws.reduce((sum, k) => sum + (k.frequency ?? 0), 0),
    topKeywords: [...new Set(sorted.map((k) => k.query))].slice(0, 4),
  }
}

async function withRetry<T>(job: ClusteringJob, attempt: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < 2; i++) {
    try {
      job.llmCalls += 1
      return await attempt()
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

/** One batch → units (clusters restricted to this batch's own keyword ids). */
async function runBatch(job: ClusteringJob, batch: BatchState, llm: LlmCall): Promise<void> {
  const kws = batch.keywordIds.map((id) => job.keywords.get(id)!)
  const raw = await withRetry(job, async () =>
    parseClusterResponse(
      await llm([
        { role: 'system', content: CLUSTERING_SYSTEM_PROMPT },
        { role: 'user', content: buildClusteringUserPrompt(kws, job.pages) },
      ]),
    ),
  )
  const byQuery = new Map<string, ClusterKeywordInput[]>()
  for (const k of kws) {
    const key = normalizeQuery(k.query)
    byQuery.set(key, [...(byQuery.get(key) ?? []), k])
  }
  const used = new Set<number>()
  batch.units = []
  raw.forEach((c, i) => {
    const matched: ClusterKeywordInput[] = []
    for (const q of c.keywords) {
      for (const k of byQuery.get(normalizeQuery(q)) ?? []) {
        if (!used.has(k.id)) {
          used.add(k.id)
          matched.push(k)
        }
      }
    }
    if (!matched.length) return
    const primary = byQuery.get(normalizeQuery(c.primaryKeyword))?.some((k) => matched.includes(k)) ? c.primaryKeyword : null
    batch.units.push({
      ...unitStats(matched),
      uid: `b${batch.index}c${i}`,
      fixed: false,
      name: c.name,
      intent: c.intent,
      primaryKeyword: primary ?? unitStats(matched).topKeywords[0],
      recommendedPageUrl: c.recommendedPageUrl,
      keywordIds: matched.map((k) => k.id),
      confidence: c.confidence,
      needsNewPage: c.needsNewPage,
      excludeFromSeo: c.excludeFromSeo,
      reason: c.reason,
    })
  })
}

async function runPendingBatches(job: ClusteringJob, llm: LlmCall, concurrency: number): Promise<void> {
  const queue = job.batches.filter((b) => b.status === 'pending' || b.status === 'failed')
  const worker = async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      batch.status = 'running'
      batch.error = undefined
      touch(job)
      try {
        await runBatch(job, batch, llm)
        batch.status = 'done'
      } catch (err) {
        batch.status = 'failed'
        batch.error = err instanceof Error ? err.message : String(err)
      }
      touch(job)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
}

function missingKeywordIds(job: ClusteringJob): number[] {
  const assigned = new Set<number>()
  for (const b of job.batches) for (const u of b.units) u.keywordIds.forEach((id) => assigned.add(id))
  const fixed = new Set(job.fixedUnits.flatMap((u) => u.keywordIds))
  return [...job.keywords.keys()].filter((id) => !assigned.has(id) && !fixed.has(id))
}

/** Merges per-batch clusters by search intent: deterministic pre-merge, then AI merge passes. */
async function mergeUnits(
  job: ClusteringJob,
  units: Unit[],
  llm: LlmCall,
  chunkSize: number,
  concurrency: number,
): Promise<Map<string, Unit[]>> {
  const byUid = new Map(units.map((u) => [u.uid, u]))
  const groups = new UnitGroups(units)
  const overrides = new Map<string, MergeGroup>()

  // Same intent + same stem signature of the main keyword ("оклейки авто" / "авто оклейка") is
  // the same cluster without asking the AI.
  const bySignature = new Map<string, string>()
  for (const u of units) {
    const key = `${u.intent}|${stemSignature(u.primaryKeyword)}`
    const first = bySignature.get(key)
    if (first) groups.union(first, u.uid)
    else bySignature.set(key, u.uid)
  }

  const pagesBlock = formatPagesForPrompt(job.pages)
  const representative = (root: string, members: string[]): MergeUnit => {
    const memberUnits = members.map((id) => byUid.get(id)!)
    const fixed = memberUnits.find((u) => u.fixed)
    const best = fixed ?? memberUnits.reduce((a, b) => (b.totalFrequency > a.totalFrequency ? b : a))
    const override = fixed ? undefined : overrides.get(root)
    const stats = unitStats(memberUnits.flatMap((u) => u.keywordIds.map((id) => job.keywords.get(id)!)))
    return {
      uid: root,
      fixed: Boolean(fixed),
      name: override?.name || best.name,
      intent: override?.intent ?? best.intent,
      primaryKeyword: override?.primaryKeyword || best.primaryKeyword,
      recommendedPageUrl: override ? override.recommendedPageUrl : best.recommendedPageUrl,
      ...stats,
    }
  }

  // A single batch was already grouped by intent in one call; merging only matters across batches
  // or when there are reviewed clusters to attach to.
  const needsAi = job.batches.filter((b) => b.units.length).length > 1 || job.fixedUnits.length > 0
  for (let pass = 0; needsAi && pass < MERGE_MAX_PASSES; pass++) {
    const members = groups.members()
    const reps = [...members.entries()].map(([root, ids]) => representative(root, ids))
    if (reps.length < 2) break
    const ordering = MERGE_ORDERINGS[pass % MERGE_ORDERINGS.length]
    reps.sort((a, b) => (ordering(a) < ordering(b) ? -1 : ordering(a) > ordering(b) ? 1 : 0))
    const chunks = chunk(reps, chunkSize).filter((c) => c.length > 1)
    job.mergePass = pass + 1
    touch(job)
    let merged = 0
    const askChunk = async (part: MergeUnit[]) => {
      const known = new Set(part.map((r) => r.uid))
      const result = await withRetry(job, async () => {
        const parsed = parseMergeResponse(
          await llm([
            { role: 'system', content: MERGE_SYSTEM_PROMPT },
            { role: 'user', content: buildMergeUserPrompt(part, pagesBlock) },
          ]),
          known,
        )
        if (!parsed) throw new ClusteringError('AI Router returned a merge response that is not valid JSON.')
        return parsed
      })
      job.mergeCallsDone += 1
      touch(job)
      // Chunks of one pass hold disjoint clusters, so their answers can be applied in any order.
      for (const g of result) {
        let joined = false
        for (const id of g.ids.slice(1)) if (groups.union(g.ids[0], id)) joined = true
        if (!joined) continue
        merged += 1
        overrides.set(groups.find(g.ids[0]), g)
      }
    }
    const queue = [...chunks]
    await Promise.all(
      Array.from({ length: Math.max(1, concurrency) }, async () => {
        for (let part = queue.shift(); part; part = queue.shift()) await askChunk(part)
      }),
    )
    // One chunk saw every cluster at once: nothing left to compare.
    if (chunks.length <= 1 || (merged === 0 && pass > 0)) break
  }

  const out = new Map<string, Unit[]>()
  for (const [root, ids] of groups.members()) {
    const memberUnits = ids.map((id) => byUid.get(id)!)
    const override = overrides.get(root)
    if (override && !memberUnits.some((u) => u.fixed)) {
      // Carry the merge answer on a synthetic leading unit; keyword ids stay on the members.
      out.set(root, [{ ...memberUnits[0], ...override, uid: `${root}*`, keywordIds: [], fixed: false } as Unit, ...memberUnits])
    } else {
      out.set(root, memberUnits)
    }
  }
  return out
}

type FinalCluster = NonNullable<ReturnType<typeof finalizeGroup>>

function finalizeGroup(job: ClusteringJob, members: Unit[], pageByUrl: Map<string, ClusterPageInput>) {
  const kwIds = [...new Set(members.flatMap((u) => u.keywordIds))]
  if (!kwIds.length) return null
  const kws = kwIds.map((id) => job.keywords.get(id)!)
  const lead = members[0].uid.endsWith('*') ? members[0] : members.reduce((a, b) => (b.totalFrequency > a.totalFrequency ? b : a))
  const totalFrequency = kws.reduce((sum, k) => sum + (k.frequency ?? 0), 0)
  const primaryCandidates = kws.filter((k) => normalizeQuery(k.query) === normalizeQuery(lead.primaryKeyword))
  const pool = primaryCandidates.length ? primaryCandidates : kws
  const primary = pool.reduce((best, k) => ((k.frequency ?? 0) > (best.frequency ?? 0) ? k : best), pool[0])

  let recommendedPage = lead.recommendedPageUrl ? pageByUrl.get(normalizePageUrl(lead.recommendedPageUrl)) ?? null : null
  if (recommendedPage && isNonSeoUtilityPage(recommendedPage.url)) recommendedPage = null
  const needsNewPage = lead.excludeFromSeo ? false : !recommendedPage
  const status = lead.excludeFromSeo
    ? 'Ignored'
    : lead.confidence < REVIEW_CONFIDENCE_THRESHOLD
      ? 'Needs review'
      : recommendedPage
        ? 'Existing page'
        : 'No page'
  return {
    name: lead.name,
    primaryKeywordId: primary?.id ?? null,
    intent: lead.intent,
    totalFrequency,
    recommendedPageId: lead.excludeFromSeo ? null : (recommendedPage?.id ?? null),
    confidence: lead.confidence,
    needsNewPage,
    reason: lead.reason,
    status,
    keywordIds: kwIds,
  }
}

/**
 * Runs (or resumes) a job: pending/failed batches → keywords the AI left out get one more batch,
 * then become single-keyword "Needs review" clusters → merge by intent → one save transaction.
 * Existing clusters are replaced only at the very end; a failure before that changes nothing in the DB.
 */
export async function runClusteringJob(pool: Pool, job: ClusteringJob, opts: ClusteringOptions = {}): Promise<ClusteringJob> {
  const llm = opts.llm ?? ((messages) => callAiRouter(messages))
  const concurrency = opts.concurrency ?? 2
  job.status = 'running'
  job.error = null
  try {
    job.phase = 'batches'
    touch(job)
    await runPendingBatches(job, llm, concurrency)
    if (job.batches.some((b) => b.status === 'failed')) {
      throw new ClusteringError(
        `Не удалось обработать ${job.batches.filter((b) => b.status === 'failed').length} из ${job.batches.length} batch. Готовые batch сохранены — нажмите «Продолжить».`,
      )
    }

    let missing = missingKeywordIds(job)
    if (missing.length && !job.batches.some((b) => b.orphan)) {
      const extra = planBatches(missing.map((id) => job.keywords.get(id)!), { batchSize: opts.batchSize ?? CLUSTER_BATCH_SIZE })
      for (const b of extra) {
        job.batches.push({ index: job.batches.length, keywordIds: b.map((k) => k.id), status: 'pending', units: [], orphan: true })
      }
      await runPendingBatches(job, llm, concurrency)
      if (job.batches.some((b) => b.status === 'failed')) {
        throw new ClusteringError('Не удалось обработать дополнительный batch. Готовые batch сохранены — нажмите «Продолжить».')
      }
      missing = missingKeywordIds(job)
    }

    const units: Unit[] = [...job.fixedUnits, ...job.batches.flatMap((b) => b.units)]
    // Never lose a keyword: whatever the AI did not place becomes its own cluster for manual review.
    missing.forEach((id, i) => {
      const k = job.keywords.get(id)!
      units.push({
        ...unitStats([k]),
        uid: `m${i}`,
        fixed: false,
        name: k.query,
        intent: 'mixed',
        primaryKeyword: k.query,
        recommendedPageUrl: null,
        keywordIds: [id],
        confidence: 0,
        needsNewPage: true,
        excludeFromSeo: false,
        reason: 'AI не распределил этот запрос — проверьте вручную.',
      })
    })

    job.phase = 'merge'
    job.mergePass = 0
    job.mergeCallsDone = 0
    touch(job)
    const grouped = await mergeUnits(job, units, llm, opts.mergeChunkSize ?? MERGE_CHUNK_SIZE, concurrency)

    job.phase = 'saving'
    touch(job)
    const pageByUrl = new Map(job.pages.map((p) => [normalizePageUrl(p.url), p]))
    const created: FinalCluster[] = []
    const attachments: { clusterId: number; keywordIds: number[] }[] = []
    for (const members of grouped.values()) {
      const fixed = members.find((u) => u.fixed)
      if (fixed) {
        const added = members.filter((u) => !u.fixed).flatMap((u) => u.keywordIds)
        if (added.length) attachments.push({ clusterId: fixed.clusterId!, keywordIds: added })
        continue
      }
      const final = finalizeGroup(job, members, pageByUrl)
      if (final) created.push(final)
    }

    // Invariant: every keyword that was not already in a reviewed cluster is saved exactly once.
    const placed = [...created.flatMap((c) => c.keywordIds), ...attachments.flatMap((a) => a.keywordIds)]
    if (placed.length !== job.toCluster || new Set(placed).size !== job.toCluster) {
      throw new ClusteringError('Clustering validation failed: keyword counts do not reconcile with the project.')
    }

    await persistClusterRun(pool, job.projectId, created, attachments)
    job.phase = 'done'
    job.status = 'done'
    job.result = {
      excludedByCleanup: job.excludedByCleanup,
      keywords: job.totalKeywords,
      processed: job.toCluster,
      clustersCreated: created.length,
      addedToReviewed: attachments.reduce((n, a) => n + a.keywordIds.length, 0),
      needsReviewKeywords: created.filter((c) => c.status === 'Needs review').reduce((n, c) => n + c.keywordIds.length, 0),
      llmCalls: job.llmCalls,
    }
  } catch (err) {
    job.status = 'failed'
    job.error = err instanceof Error ? err.message : String(err)
  }
  touch(job)
  return job
}

/**
 * Replaces the AI-generated (still pending review) clusters of the project with the new run in one
 * transaction. Human-reviewed clusters stay as they are and only receive newly matched keywords.
 */
async function persistClusterRun(
  pool: Pool,
  projectId: number,
  created: FinalCluster[],
  attachments: { clusterId: number; keywordIds: number[] }[],
): Promise<void> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM seo_clusters WHERE project_id = $1 AND review_status = 'pending'`, [projectId])
    for (const c of created) {
      const { rows } = await client.query(
        `INSERT INTO seo_clusters
          (project_id, name, primary_keyword_id, intent, total_frequency, recommended_page_id, confidence, needs_new_page, reason, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [projectId, c.name, c.primaryKeywordId, c.intent, c.totalFrequency, c.recommendedPageId, c.confidence, c.needsNewPage, c.reason, c.status],
      )
      await client.query(
        `INSERT INTO seo_cluster_keywords (cluster_id, keyword_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`,
        [rows[0].id, c.keywordIds],
      )
    }
    for (const a of attachments) {
      await client.query(
        `INSERT INTO seo_cluster_keywords (cluster_id, keyword_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`,
        [a.clusterId, a.keywordIds],
      )
      await client.query(
        `UPDATE seo_clusters SET total_frequency = (
           SELECT COALESCE(sum(k.frequency), 0) FROM seo_cluster_keywords sck JOIN keywords k ON k.id = sck.keyword_id WHERE sck.cluster_id = $1
         ), updated_at = now() WHERE id = $1`,
        [a.clusterId],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Synchronous variant (plan + run); throws on failure. */
export async function generateClustersForProject(pool: Pool, projectId: number, opts: ClusteringOptions = {}): Promise<ClusteringJob> {
  const job = await runClusteringJob(pool, await createClusteringJob(pool, projectId, opts), opts)
  if (job.status !== 'done') throw new ClusteringError(job.error ?? 'Clustering failed.')
  return job
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
