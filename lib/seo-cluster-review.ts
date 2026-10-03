import type { Pool } from 'pg'
import { callAiRouter, SEO_BULK_ROUTE, type AiRouterMessage } from './ai-router.ts'
import { seoContextBlock } from './keywords-relevance-rules.ts'
import { getProjectSeoContext } from './project-seo-context.ts'
import { chunk, parseJsonObject } from './seo-clustering-batch.ts'
import { isNonSeoUtilityPage, normalizePageUrl, type AiClusterDecision, type LlmCall } from './seo-clustering.ts'

// «AI проверить все кластеры»: one decision per cluster — CREATE a page, IMPROVE an existing page,
// or IGNORE. It only PREPARES decisions (AI layer of seo_clusters + suggested slug/H1/Title); it never
// creates pages and never touches a cluster a human already reviewed (review_status <> 'pending').

export class ClusterAiReviewError extends Error {}

export const CLUSTER_REVIEW_BATCH_SIZE = 12
export const CLUSTER_REVIEW_KEYWORDS_PER_CLUSTER = 15
const CLUSTER_REVIEW_CONCURRENCY = 3
const CLUSTER_REVIEW_MAX_PAGES = 200
const CLUSTER_REVIEW_MAX_OUTPUT_TOKENS = 4000

export const CLUSTER_REVIEW_SYSTEM_PROMPT = `You are an SEO strategist deciding what to do with each keyword CLUSTER of one website. You get the project's SEO CONTEXT, its EXISTING PAGES and a list of clusters (every cluster lists its keywords with frequency). Judge by the WHOLE cluster, never by one keyword.

For every cluster choose exactly one decision:
- "C" (CREATE a new page): the cluster is a separate, useful SEO intent that no existing page covers. Never CREATE a thin page for a synonym, a micro-geo variant, or a cluster of one low-frequency query.
- "I" (IMPROVE an existing page): the intent is already covered by one of the EXISTING PAGES. Give that page's exact url from the list; never invent one, never pick a generic About / Contact / Cases page as filler.
- "X" (IGNORE): navigational or junk intent (a third-party brand, product or person), a duplicate of another cluster's intent, or an intent too narrow to deserve its own page (it should rather go into another page), or it would break "one intent = one page".

Rules:
1. One intent = one page. If two clusters of this list share one intent, CREATE (or IMPROVE) for the stronger one and IGNORE the weaker as a duplicate.
2. Use the SEO CONTEXT literally: services, planned directions and the target region are the business; NOT OFFERED topics are not a reason to create a page.
3. For "C" propose: a latin lowercase url "slug" (words joined by "-", no domain, no slashes at the ends), an "H1" and a "Title" (Title up to 60 characters) in the language of the keywords.
4. "reason" is one short sentence in the language of the keywords.
5. Answer for EVERY cluster id you were given, no extras. Return ONLY compact strict JSON, no markdown:
{"d":[[id,"C",slug,H1,Title,reason],[id,"I",pageUrl,reason],[id,"X",reason]]}`

export type ReviewCluster = {
  id: number
  name: string
  intent: string | null
  totalFrequency: number
  keywords: { query: string; frequency: number | null }[]
}

export type ReviewPage = { id: number; url: string; title: string | null; h1: string | null }

export type ClusterDecision =
  | { id: number; decision: 'create'; slug: string; h1: string; title: string; reason: string }
  | { id: number; decision: 'improve'; pageId: number; reason: string }
  | { id: number; decision: 'ignore'; reason: string }

function clip(text: unknown, max: number): string {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function sanitizeSlug(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, 80)
}

export function buildClusterReviewContext(project: { name: string; domain: string }, seoBlock: string, pages: ReviewPage[]): string {
  const shown = pages.slice(0, CLUSTER_REVIEW_MAX_PAGES)
  const lines = shown.map((p) => {
    const bits = [p.url]
    if (p.title) bits.push(`title: ${clip(p.title, 120)}`)
    if (p.h1) bits.push(`h1: ${clip(p.h1, 120)}`)
    return `- ${bits.join(' | ')}`
  })
  return `PROJECT: ${project.name} (${project.domain})
${seoBlock}
EXISTING PAGES (${shown.length}${pages.length > shown.length ? ` of ${pages.length}` : ''}):
${lines.length ? lines.join('\n') : '(this project has no existing pages yet)'}`
}

export function buildClusterReviewUserPrompt(context: string, clusters: ReviewCluster[]): string {
  const blocks = clusters.map((c) => {
    const shown = c.keywords.slice(0, CLUSTER_REVIEW_KEYWORDS_PER_CLUSTER)
    const rest = c.keywords.length - shown.length
    const kws = shown.map((k) => `${k.query} (${k.frequency ?? 0})`).join('; ')
    return `[${c.id}] ${c.name} | intent: ${c.intent ?? 'n/a'} | total frequency: ${c.totalFrequency} | keywords (${c.keywords.length}): ${kws}${rest > 0 ? `; … +${rest} more` : ''}`
  })
  return `${context}

CLUSTERS (${clusters.length}):
${blocks.join('\n')}

Decide for every cluster id and return the compact JSON described in your instructions.`
}

/**
 * Parses and validates one batch answer. Items the model got wrong (unknown id, an IMPROVE url that is not
 * a page of the project, a CREATE without slug/H1/Title, a repeated id) are dropped — those clusters simply
 * stay un-reviewed and can be continued. Throws when the answer is not parseable at all.
 */
export function parseClusterReviewResponse(raw: string, clusterIds: Set<number>, pages: ReviewPage[]): ClusterDecision[] {
  const data = parseJsonObject(raw)
  const rows = data?.d
  if (!Array.isArray(rows)) throw new ClusterAiReviewError('AI Router returned a cluster review that is not valid JSON.')
  const pageByUrl = new Map<string, ReviewPage>()
  for (const p of pages) if (!isNonSeoUtilityPage(p.url)) pageByUrl.set(normalizePageUrl(p.url), p)

  const out = new Map<number, ClusterDecision>()
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const id = Number(row[0])
    if (!Number.isInteger(id) || !clusterIds.has(id) || out.has(id)) continue
    const code = String(row[1] ?? '').trim().toUpperCase()
    if (code === 'C') {
      const slug = sanitizeSlug(row[2])
      const h1 = clip(row[3], 160)
      const title = clip(row[4], 160)
      if (slug && h1 && title) out.set(id, { id, decision: 'create', slug, h1, title, reason: clip(row[5], 400) })
    } else if (code === 'I') {
      const page = pageByUrl.get(normalizePageUrl(String(row[2] ?? '')))
      if (page) out.set(id, { id, decision: 'improve', pageId: page.id, reason: clip(row[3], 400) })
    } else if (code === 'X') {
      out.set(id, { id, decision: 'ignore', reason: clip(row[2], 400) })
    }
  }
  return [...out.values()]
}

/**
 * Writes decisions into the AI layer. Only clusters still `review_status = 'pending'` are written (checked in the
 * UPDATE itself, so a decision the user makes while the batch runs is never overwritten). Returns the decisions that were actually saved.
 * status mapping reuses the clustering statuses: create → 'No page', improve → 'Existing page', ignore → 'Ignored'.
 */
export async function saveClusterDecisions(pool: Pool, projectId: number, decisions: ClusterDecision[]): Promise<ClusterDecision[]> {
  const saved: ClusterDecision[] = []
  for (const d of decisions) {
    const page = d.decision === 'improve' ? d.pageId : null
    const status = d.decision === 'create' ? 'No page' : d.decision === 'improve' ? 'Existing page' : 'Ignored'
    const { rowCount } = await pool.query(
      `UPDATE seo_clusters
       SET ai_decision = $3, status = $4, recommended_page_id = $5, needs_new_page = $6, reason = $7,
           suggested_slug = $8, suggested_h1 = $9, suggested_title = $10, updated_at = now()
       WHERE id = $1 AND project_id = $2 AND review_status = 'pending'
         AND ($5::int IS NULL OR EXISTS (SELECT 1 FROM pages p WHERE p.id = $5 AND p.project_id = $2))`,
      [
        d.id,
        projectId,
        d.decision,
        status,
        page,
        d.decision === 'create',
        d.reason || null,
        d.decision === 'create' ? d.slug : null,
        d.decision === 'create' ? d.h1 : null,
        d.decision === 'create' ? d.title : null,
      ],
    )
    if (rowCount) saved.push(d)
  }
  return saved
}

export type ClusterReviewJob = {
  projectId: number
  status: 'running' | 'failed' | 'done'
  total: number
  /** Clusters with a saved decision in this run. */
  reviewed: number
  /** Clusters the model skipped or answered invalidly — left un-reviewed. */
  skipped: number
  batchesTotal: number
  batchesDone: number
  batchesFailed: number
  counts: Record<AiClusterDecision, number>
  error: string | null
  startedAt: string
  updatedAt: string
}

export type ClusterReviewOptions = {
  /** Injected in tests; production uses the AI Router pinned to DeepSeek via SEO_BULK_ROUTE. */
  llm?: LlmCall
  /** Re-decide clusters the AI already reviewed (still never touches human-reviewed ones). */
  force?: boolean
  batchSize?: number
  concurrency?: number
}

/** The production LLM call: BULK route (deepseek, no fallback, reasoning off). */
export const bulkReviewLlm: LlmCall = (messages: AiRouterMessage[]) =>
  callAiRouter(messages, { ...SEO_BULK_ROUTE, task: 'seo-cluster-review', maxTokens: CLUSTER_REVIEW_MAX_OUTPUT_TOKENS, temperature: 0 })

const jobs: Map<number, ClusterReviewJob> = ((globalThis as { __olnooClusterReviewJobs?: Map<number, ClusterReviewJob> }).__olnooClusterReviewJobs ??= new Map())

export function getClusterReviewJob(projectId: number): ClusterReviewJob | null {
  return jobs.get(projectId) ?? null
}

/**
 * Reviews every cluster of the project that is still pending and not yet decided by the AI (or all pending ones
 * with `force`). Batches that fail are counted and skipped; finished decisions stay saved and a re-run continues
 * with what is left.
 */
export async function runClusterReview(pool: Pool, projectId: number, opts: ClusterReviewOptions = {}): Promise<ClusterReviewJob> {
  const llm = opts.llm ?? bulkReviewLlm
  const { rows: projectRows } = await pool.query('SELECT name, domain FROM projects WHERE id = $1', [projectId])
  if (!projectRows[0]) throw new ClusterAiReviewError('Project not found.')

  const { rows: clusterRows } = await pool.query(
    `SELECT sc.id, sc.name, sc.intent, sc.total_frequency
     FROM seo_clusters sc
     WHERE sc.project_id = $1 AND sc.review_status = 'pending' ${opts.force ? '' : 'AND sc.ai_decision IS NULL'}
     ORDER BY sc.total_frequency DESC NULLS LAST, sc.id ASC`,
    [projectId],
  )
  const { rows: kwRows } = clusterRows.length
    ? await pool.query(
        `SELECT sck.cluster_id, k.query, k.frequency
         FROM seo_cluster_keywords sck JOIN keywords k ON k.id = sck.keyword_id
         WHERE sck.cluster_id = ANY($1::int[])
         ORDER BY k.frequency DESC NULLS LAST, k.query ASC`,
        [clusterRows.map((r) => r.id)],
      )
    : { rows: [] }
  const kwByCluster = new Map<number, { query: string; frequency: number | null }[]>()
  for (const r of kwRows) {
    const list = kwByCluster.get(r.cluster_id) ?? []
    list.push({ query: r.query, frequency: r.frequency })
    kwByCluster.set(r.cluster_id, list)
  }
  const clusters: ReviewCluster[] = clusterRows.map((r) => ({
    id: r.id,
    name: r.name,
    intent: r.intent,
    totalFrequency: r.total_frequency ?? 0,
    keywords: kwByCluster.get(r.id) ?? [],
  }))

  const { rows: pages } = await pool.query<ReviewPage>(`SELECT id, url, title, h1 FROM pages WHERE project_id = $1 ORDER BY url ASC`, [projectId])
  const context = buildClusterReviewContext(projectRows[0], seoContextBlock(await getProjectSeoContext(pool, projectId)), pages)

  const batches = chunk(clusters, opts.batchSize ?? CLUSTER_REVIEW_BATCH_SIZE)
  const now = () => new Date().toISOString()
  const job: ClusterReviewJob = {
    projectId,
    status: 'running',
    total: clusters.length,
    reviewed: 0,
    skipped: 0,
    batchesTotal: batches.length,
    batchesDone: 0,
    batchesFailed: 0,
    counts: { create: 0, improve: 0, ignore: 0 },
    error: null,
    startedAt: now(),
    updatedAt: now(),
  }
  jobs.set(projectId, job)
  void execute(pool, job, batches, context, pages, llm, opts.concurrency ?? CLUSTER_REVIEW_CONCURRENCY)
  return job
}

async function execute(
  pool: Pool,
  job: ClusterReviewJob,
  batches: ReviewCluster[][],
  context: string,
  pages: ReviewPage[],
  llm: LlmCall,
  concurrency: number,
): Promise<void> {
  const queue = [...batches]
  const worker = async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      try {
        const raw = await llm([
          { role: 'system', content: CLUSTER_REVIEW_SYSTEM_PROMPT },
          { role: 'user', content: buildClusterReviewUserPrompt(context, batch) },
        ])
        const decisions = parseClusterReviewResponse(raw, new Set(batch.map((c) => c.id)), pages)
        const saved = await saveClusterDecisions(pool, job.projectId, decisions)
        for (const d of saved) job.counts[d.decision] += 1
        job.reviewed += saved.length
        job.skipped += batch.length - saved.length
        job.batchesDone += 1
      } catch (err) {
        job.batchesFailed += 1
        job.error = err instanceof Error ? err.message : String(err)
      }
      job.updatedAt = new Date().toISOString()
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker))
    job.status = job.batchesFailed > 0 ? 'failed' : 'done'
  } catch (err) {
    job.status = 'failed'
    job.error = err instanceof Error ? err.message : String(err)
  }
  job.updatedAt = new Date().toISOString()
}

/** Resolves once the job left `running` (tests and scripts; the UI polls instead). */
export async function waitForClusterReview(job: ClusterReviewJob, timeoutMs = 10_000): Promise<ClusterReviewJob> {
  const until = Date.now() + timeoutMs
  while (job.status === 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
  return job
}

/** Starts a run, or returns the one already running for the project. */
export async function startClusterReview(pool: Pool, projectId: number, opts: ClusterReviewOptions = {}): Promise<ClusterReviewJob> {
  const existing = jobs.get(projectId)
  if (existing?.status === 'running') return existing
  return runClusterReview(pool, projectId, opts)
}
