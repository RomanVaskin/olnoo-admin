import type { Pool, PoolClient } from 'pg'
import { callAiRouter, type AiRouterMessage } from './ai-router.ts'
import {
  buildProjectContext,
  buildRelevanceUserPrompt,
  contextCaps,
  contextPageCount,
  seoContextKnowsBusiness,
  type ContextCaps,
  decide,
  isRelevanceStatus,
  parseRelevanceResponse,
  planRelevanceBatches,
  relevanceMaxOutputTokens,
  RELEVANCE_BATCH_SIZE,
  RELEVANCE_CONCURRENCY,
  RELEVANCE_STATUSES,
  RELEVANCE_SYSTEM_PROMPT,
  type RelevanceGroup,
  type RelevanceStatus,
} from './keywords-relevance-rules.ts'
import { getProjectSeoContext } from './project-seo-context.ts'

// AI relevance cleanup of a project's search queries — the stage BEFORE clustering. Keywords are
// never deleted: each one gets relevance_status / confidence / reason; clustering later reads the
// live status (see CLUSTERING_KEYWORD_FILTER_SQL). Jobs mirror the clustering jobs: one in-memory
// run per project, batches saved to the DB the moment they succeed, so a failed batch or even a
// restart loses nothing — starting again simply selects what is still unclassified.

export class RelevanceError extends Error {}

export type LlmCallOptions = { maxTokens?: number; reasoningMode?: 'off' | 'low' | 'medium' | 'high'; task?: string }
export type LlmCall = (messages: AiRouterMessage[], opts?: LlmCallOptions) => Promise<string>

export type RelevanceOptions = {
  /** Injected in tests; production uses the AI Router. */
  llm?: LlmCall
  batchSize?: number
  concurrency?: number
  /** Service-level only: re-check keywords a person set by hand (clears their manual flag). */
  reviewManual?: boolean
}

export type RelevanceSummary = {
  total: number
  unclassified: number
  target: number
  informational: number
  uncertain: number
  geo_mismatch: number
  irrelevant: number
  manual: number
  /** Keywords the AI (not a person) put in uncertain / geo_mismatch — what «Перепроверить спорные» re-sends. */
  disputed: number
  /** Keywords the AI (not a person) put in geo_mismatch — what «Перепроверить другой регион» re-sends. */
  geoAi: number
  /** Decisions made by the AI (classified and not manual) — what a full recheck re-sends. */
  aiDecided: number
  /** Pages of the project: with none (and no SEO context), the AI has no business context. */
  pages: number
  /** The project's explicit SEO context names the business (type or services). */
  seoContext: boolean
  /** projects.relevance_cleanup_at is set: clustering only takes target/informational. */
  usesCleanup: boolean
}

export async function getRelevanceSummary(pool: Pool, projectId: number): Promise<RelevanceSummary> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE k.relevance_status IS NULL)::int AS unclassified,
            count(*) FILTER (WHERE k.relevance_status = 'target')::int AS target,
            count(*) FILTER (WHERE k.relevance_status = 'informational')::int AS informational,
            count(*) FILTER (WHERE k.relevance_status = 'uncertain')::int AS uncertain,
            count(*) FILTER (WHERE k.relevance_status = 'geo_mismatch')::int AS geo_mismatch,
            count(*) FILTER (WHERE k.relevance_status = 'irrelevant')::int AS irrelevant,
            count(*) FILTER (WHERE k.relevance_manual)::int AS manual,
            count(*) FILTER (WHERE k.relevance_status IN ('uncertain', 'geo_mismatch') AND NOT k.relevance_manual)::int AS disputed,
            count(*) FILTER (WHERE k.relevance_status = 'geo_mismatch' AND NOT k.relevance_manual)::int AS geo_ai,
            count(*) FILTER (WHERE k.relevance_status IS NOT NULL AND NOT k.relevance_manual)::int AS ai_decided,
            (SELECT count(*)::int FROM pages WHERE project_id = $1) AS pages,
            (SELECT relevance_cleanup_at IS NOT NULL FROM projects WHERE id = $1) AS uses_cleanup
     FROM keywords k WHERE k.project_id = $1`,
    [projectId],
  )
  const { ai_decided, geo_ai, uses_cleanup, ...r } = rows[0]
  return { ...r, aiDecided: ai_decided, geoAi: geo_ai, seoContext: seoContextKnowsBusiness(await getProjectSeoContext(pool, projectId)), usesCleanup: uses_cleanup === true }
}

type Batch = {
  index: number
  groups: RelevanceGroup[]
  status: 'pending' | 'running' | 'done' | 'failed'
  error?: string
  /** Second-chance batch for queries the AI left out of their first batch. */
  orphan: boolean
}

export type RelevanceJobStatus = 'running' | 'failed' | 'done'

export type RelevanceResult = {
  /** Keyword rows classified by this run. */
  checked: number
  byStatus: Record<RelevanceStatus, number>
  /** Rows whose AI status was below its confidence threshold and was saved as 'uncertain'. */
  downgraded: number
  /** Rows the AI never answered for; they stay unclassified and are picked up by the next run. */
  unresolved: number
  /** Rows kept as 'uncertain' instead of an exclusion because the project has no page data. */
  heldNoContext: number
  /** geo_mismatch answers turned into 'uncertain': the place is inside the target region or no region was named. */
  geoRejected: number
  llmCalls: number
}

export type RelevanceJob = {
  id: string
  projectId: number
  status: RelevanceJobStatus
  totalKeywords: number
  processedKeywords: number
  batches: Batch[]
  llmCalls: number
  downgraded: number
  heldNoContext: number
  geoRejected: number
  /** The explicit target region of the SEO context ('' when none) — what a geo_mismatch is checked against. */
  targetRegion: string
  /** What the AI can know about the project (explicit SEO context or page data); exclusions it cannot back are held. */
  contextCaps: ContextCaps
  /** The AI knows at least the business or the region. */
  hasContext: boolean
  byStatus: Record<RelevanceStatus, number>
  error: string | null
  result: RelevanceResult | null
  startedAt: string
  updatedAt: string
  reviewManual: boolean
  context: string
  /** Every id this run may write — nothing outside it is ever touched. */
  scope: Map<number, string>
}

export type RelevanceJobView = {
  id: string
  projectId: number
  status: RelevanceJobStatus
  totalKeywords: number
  processedKeywords: number
  batchesDone: number
  batchesTotal: number
  failedBatches: number
  batchErrors: string[]
  error: string | null
  result: RelevanceResult | null
}

export function viewRelevanceJob(job: RelevanceJob): RelevanceJobView {
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    totalKeywords: job.totalKeywords,
    processedKeywords: job.processedKeywords,
    batchesDone: job.batches.filter((b) => b.status === 'done').length,
    batchesTotal: job.batches.length,
    failedBatches: job.batches.filter((b) => b.status === 'failed').length,
    batchErrors: [...new Set(job.batches.filter((b) => b.status === 'failed' && b.error).map((b) => b.error!.slice(0, 240)))].slice(0, 3),
    error: job.error,
    result: job.result,
  }
}

const touch = (job: RelevanceJob) => {
  job.updatedAt = new Date().toISOString()
}
const emptyCounts = (): Record<RelevanceStatus, number> => ({ target: 0, informational: 0, uncertain: 0, geo_mismatch: 0, irrelevant: 0 })

/**
 * Plans a run over what still needs AI: unclassified keywords only (NULL status, not manual).
 * Already classified keywords and manual overrides are never selected, so a repeat run costs
 * nothing when there is nothing new; after a new Wordstat import only the new rows qualify.
 */
export async function createRelevanceJob(pool: Pool, projectId: number, opts: RelevanceOptions = {}): Promise<RelevanceJob> {
  const { rows: projectRows } = await pool.query('SELECT name, domain FROM projects WHERE id = $1', [projectId])
  if (!projectRows[0]) throw new RelevanceError('Неизвестный проект')

  const reviewManual = opts.reviewManual === true
  const { rows } = await pool.query<{ id: number; query: string }>(
    `SELECT id, query FROM keywords
     WHERE project_id = $1 AND ${reviewManual ? 'relevance_manual' : 'relevance_status IS NULL AND NOT relevance_manual'}
     ORDER BY frequency DESC NULLS LAST, id ASC`,
    [projectId],
  )
  if (rows.length === 0) {
    const { total } = await getRelevanceSummary(pool, projectId)
    throw new RelevanceError(
      total === 0
        ? 'В проекте нет ключевых слов — сначала импортируйте Wordstat.'
        : reviewManual
          ? 'Нет вручную изменённых запросов для повторной проверки.'
          : 'Все запросы уже проверены — новых нет.',
    )
  }
  const { rows: pageRows } = await pool.query(
    `SELECT url, title, h1, description FROM pages WHERE project_id = $1 ORDER BY url ASC`,
    [projectId],
  )

  const seoContext = await getProjectSeoContext(pool, projectId)
  const caps = contextCaps(seoContext, pageRows)
  const batches = planRelevanceBatches(rows, { batchSize: opts.batchSize ?? RELEVANCE_BATCH_SIZE })
  const now = new Date().toISOString()
  return {
    id: `${projectId}-${Date.now().toString(36)}`,
    projectId,
    status: 'running',
    totalKeywords: rows.length,
    processedKeywords: 0,
    batches: batches.map((groups, index) => ({ index, groups, status: 'pending', orphan: false })),
    llmCalls: 0,
    downgraded: 0,
    heldNoContext: 0,
    geoRejected: 0,
    targetRegion: seoContext?.region ?? '',
    contextCaps: caps,
    hasContext: caps.business || caps.region,
    byStatus: emptyCounts(),
    error: null,
    result: null,
    startedAt: now,
    updatedAt: now,
    reviewManual,
    context: buildProjectContext(projectRows[0], pageRows, seoContext),
    scope: new Map(rows.map((r) => [r.id, r.query])),
  }
}

async function withRetry<T>(job: RelevanceJob, attempt: (attempt: number) => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < 2; i++) {
    try {
      job.llmCalls += 1
      return await attempt(i)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

/**
 * One batch: AI call → validate → save in ONE transaction. The UPDATE re-checks the guard, so an AI
 * answer can never overwrite a manual override or an already classified keyword (e.g. a person
 * classified it while the run was in progress) — those rows are simply left alone.
 */
async function runBatch(pool: Pool, job: RelevanceJob, batch: Batch, llm: LlmCall): Promise<void> {
  const sent = new Map(batch.groups.map((g) => [g.repId, g]))
  const items = await withRetry(job, async (attempt) => {
    const parsed = parseRelevanceResponse(
      await llm(
        [
          { role: 'system', content: RELEVANCE_SYSTEM_PROMPT },
          { role: 'user', content: buildRelevanceUserPrompt(job.context, batch.groups.map((g) => ({ keywordId: g.repId, query: g.query }))) },
        ],
        // Bulk classification needs no deep reasoning; the output limit is sized to the batch (retry: doubled).
        { maxTokens: relevanceMaxOutputTokens(batch.groups.length, attempt), reasoningMode: 'off', task: 'seo-relevance-cleanup' },
      ),
      new Set(sent.keys()),
    )
    if (!parsed) throw new RelevanceError('AI Router вернул ответ, который не удалось разобрать.')
    return parsed
  })

  const ids: number[] = []
  const statuses: string[] = []
  const confidences: number[] = []
  const reasons: string[] = []
  const counts = emptyCounts()
  let downgraded = 0
  let held = 0
  let geoRejected = 0
  for (const item of items) {
    const group = sent.get(item.keywordId)!
    const d = decide(item.status, item.confidence, item.reason, job.contextCaps, { queryRegion: item.queryRegion, targetRegion: job.targetRegion })
    if (d.downgraded) downgraded += group.ids.length
    if (d.held) held += group.ids.length
    if (d.geoRejected) geoRejected += group.ids.length
    counts[d.status] += group.ids.length
    for (const id of group.ids) {
      ids.push(id)
      statuses.push(d.status)
      confidences.push(d.confidence)
      reasons.push(d.reason)
    }
  }

  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rowCount } = await client.query(
      `UPDATE keywords k
       SET relevance_status = v.s, relevance_confidence = v.c, relevance_reason = v.r,
           relevance_manual = false, relevance_checked_at = now()
       FROM unnest($1::int[], $2::text[], $3::int[], $4::text[]) AS v(id, s, c, r)
       WHERE k.id = v.id AND k.project_id = $5
         AND (($6::boolean AND k.relevance_manual) OR (NOT $6::boolean AND k.relevance_status IS NULL AND NOT k.relevance_manual))`,
      [ids, statuses, confidences, reasons, job.projectId, job.reviewManual],
    )
    // The project starts using cleanup with its first saved batch (and keeps doing so).
    await client.query('UPDATE projects SET relevance_cleanup_at = COALESCE(relevance_cleanup_at, now()) WHERE id = $1', [job.projectId])
    await client.query('COMMIT')
    job.processedKeywords += rowCount ?? 0
    job.downgraded += downgraded
    job.heldNoContext += held
    job.geoRejected += geoRejected
    for (const s of RELEVANCE_STATUSES) job.byStatus[s] += counts[s]
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function runPending(pool: Pool, job: RelevanceJob, llm: LlmCall, concurrency: number): Promise<void> {
  const queue = job.batches.filter((b) => b.status === 'pending' || b.status === 'failed')
  const worker = async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      batch.status = 'running'
      batch.error = undefined
      touch(job)
      try {
        await runBatch(pool, job, batch, llm)
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

/** Ids of this run's scope that are still unclassified (the AI skipped them or their items were invalid). */
async function stillUnclassified(pool: Pool, job: RelevanceJob): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(
    job.reviewManual
      ? `SELECT id FROM keywords WHERE id = ANY($1::int[]) AND relevance_manual`
      : `SELECT id FROM keywords WHERE id = ANY($1::int[]) AND relevance_status IS NULL AND NOT relevance_manual`,
    [[...job.scope.keys()]],
  )
  return rows.map((r) => r.id)
}

/**
 * Runs (or resumes) a job: pending/failed batches, then one more batch for queries the AI left out.
 * A failed batch stops the job in state 'failed' with everything saved so far kept; calling this
 * again on the same job redoes only the failed batches.
 */
export async function runRelevanceJob(pool: Pool, job: RelevanceJob, opts: RelevanceOptions = {}): Promise<RelevanceJob> {
  const llm = opts.llm ?? ((messages, o) => callAiRouter(messages, o))
  job.status = 'running'
  job.error = null
  try {
    touch(job)
    await runPending(pool, job, llm, opts.concurrency ?? RELEVANCE_CONCURRENCY)
    if (job.batches.some((b) => b.status === 'failed' && !b.orphan)) {
      const failed = job.batches.filter((b) => b.status === 'failed').length
      throw new RelevanceError(`Не удалось обработать ${failed} из ${job.batches.length} batch. Готовые результаты сохранены — нажмите «Продолжить».`)
    }

    if (!job.batches.some((b) => b.orphan)) {
      const left = new Set(await stillUnclassified(pool, job))
      if (left.size) {
        const rows = [...left].map((id) => ({ id, query: job.scope.get(id)! }))
        for (const groups of planRelevanceBatches(rows, { batchSize: opts.batchSize ?? RELEVANCE_BATCH_SIZE })) {
          job.batches.push({ index: job.batches.length, groups, status: 'pending', orphan: true })
        }
        // A second-chance batch that yields nothing is not an error of the run: those queries just
        // stay unclassified and are reported as `unresolved` — the next run picks them up.
        await runPending(pool, job, llm, opts.concurrency ?? RELEVANCE_CONCURRENCY)
      }
    }

    const unresolved = (await stillUnclassified(pool, job)).length
    job.status = 'done'
    job.result = {
      checked: job.processedKeywords,
      byStatus: job.byStatus,
      downgraded: job.downgraded,
      unresolved,
      heldNoContext: job.heldNoContext,
      geoRejected: job.geoRejected,
      llmCalls: job.llmCalls,
    }
  } catch (err) {
    job.status = 'failed'
    job.error = err instanceof Error ? err.message : String(err)
  }
  touch(job)
  return job
}

/** Synchronous plan + run; throws on failure. */
export async function cleanupKeywordsForProject(pool: Pool, projectId: number, opts: RelevanceOptions = {}): Promise<RelevanceJob> {
  const job = await runRelevanceJob(pool, await createRelevanceJob(pool, projectId, opts), opts)
  if (job.status !== 'done') throw new RelevanceError(job.error ?? 'Cleanup failed.')
  return job
}

// One job per project, kept in memory of the single OLNOO Admin process (globalThis survives dev HMR).
const jobs: Map<number, RelevanceJob> = ((globalThis as { __olnooRelevanceJobs?: Map<number, RelevanceJob> }).__olnooRelevanceJobs ??= new Map())

/** Lets another orchestrator (the cluster pipeline) show its cleanup run on the cleanup screen too. */
export function trackRelevanceJob(job: RelevanceJob): void {
  jobs.set(job.projectId, job)
}

export function getRelevanceJob(projectId: number): RelevanceJob | null {
  return jobs.get(projectId) ?? null
}

/**
 * Puts the keywords the AI judged uncertain / geo_mismatch back to «not checked» so the next
 * cleanup re-sends them (e.g. after the project got page data). A person's manual decisions are
 * never touched; clustering input does not change (both statuses were excluded anyway).
 * Returns how many keywords were reset.
 */
export async function requeueDisputedKeywords(pool: Pool, projectId: number): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE keywords SET relevance_status = NULL, relevance_confidence = NULL, relevance_reason = NULL, relevance_checked_at = NULL
     WHERE project_id = $1 AND relevance_status IN ('uncertain', 'geo_mismatch') AND NOT relevance_manual`,
    [projectId],
  )
  return rowCount ?? 0
}

/**
 * Puts only the AI's geo_mismatch keywords back to «not checked» — the cheapest recheck after a
 * geography rule changed. Manual decisions and every other status are untouched.
 */
export async function requeueGeoMismatchKeywords(pool: Pool, projectId: number): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE keywords SET relevance_status = NULL, relevance_confidence = NULL, relevance_reason = NULL, relevance_checked_at = NULL
     WHERE project_id = $1 AND relevance_status = 'geo_mismatch' AND NOT relevance_manual`,
    [projectId],
  )
  return rowCount ?? 0
}

/**
 * Full recheck: puts EVERY AI decision back to «not checked» (for when the project's SEO context
 * changed substantially). Manual decisions are never touched; keywords, frequencies, imports and
 * clusters are not touched either. Until the cleanup that follows has re-checked them the reset
 * keywords are out of clustering input, like any unchecked keyword. Returns how many were reset.
 */
export async function requeueAllAiDecisions(pool: Pool, projectId: number): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE keywords SET relevance_status = NULL, relevance_confidence = NULL, relevance_reason = NULL, relevance_checked_at = NULL
     WHERE project_id = $1 AND relevance_status IS NOT NULL AND NOT relevance_manual`,
    [projectId],
  )
  return rowCount ?? 0
}

/**
 * Starts a background run (or returns the running one). `resume` redoes only the failed batches of
 * a failed run; `requeueDisputed` first resets the AI's uncertain / geo_mismatch keywords (not manual
 * ones); `requeueAll` first resets every AI decision (see `requeueAllAiDecisions`).
 */
export async function startRelevanceJob(
  pool: Pool,
  projectId: number,
  {
    resume = false,
    reviewManual = false,
    requeueDisputed = false,
    requeueAll = false,
    requeueGeo = false,
  }: { resume?: boolean; reviewManual?: boolean; requeueDisputed?: boolean; requeueAll?: boolean; requeueGeo?: boolean } = {},
): Promise<RelevanceJob> {
  const existing = jobs.get(projectId)
  if (existing?.status === 'running') return existing
  if (!(resume && existing?.status === 'failed')) {
    if (requeueAll) await requeueAllAiDecisions(pool, projectId)
    else if (requeueGeo) await requeueGeoMismatchKeywords(pool, projectId)
    else if (requeueDisputed) await requeueDisputedKeywords(pool, projectId)
  }
  const job = resume && existing?.status === 'failed' ? existing : await createRelevanceJob(pool, projectId, { reviewManual })
  if (job !== existing) jobs.set(projectId, job)
  void runRelevanceJob(pool, job).catch((err) => {
    job.status = 'failed'
    job.error = err instanceof Error ? err.message : String(err)
  })
  return job
}

export type RelevanceRow = {
  id: number
  query: string
  frequency: number | null
  region: string | null
  status: RelevanceStatus | null
  confidence: number | null
  reason: string | null
  manual: boolean
}

/** A page of a project's keywords with their classification; `status` = 'unclassified' | a status | undefined (all). */
export async function listKeywordRelevance(
  pool: Pool,
  projectId: number,
  { status, limit, offset }: { status?: string; limit: number; offset: number },
): Promise<{ rows: RelevanceRow[]; total: number }> {
  const filter = status === 'unclassified' ? 'AND relevance_status IS NULL' : isRelevanceStatus(status) ? 'AND relevance_status = $4' : ''
  const params: unknown[] = [projectId, limit, offset]
  if (isRelevanceStatus(status)) params.push(status)
  const { rows } = await pool.query(
    `SELECT id, query, frequency, region, relevance_status AS status, relevance_confidence AS confidence,
            relevance_reason AS reason, relevance_manual AS manual, count(*) OVER ()::int AS total
     FROM keywords WHERE project_id = $1 ${filter}
     ORDER BY frequency DESC NULLS LAST, query ASC LIMIT $2 OFFSET $3`,
    params,
  )
  return { rows: rows.map(({ total: _t, ...r }) => r as RelevanceRow), total: rows[0]?.total ?? 0 }
}

/**
 * A person's decision. A status → saved with relevance_manual = true (ordinary cleanup then never
 * touches it). `null` → back to «not checked»: the manual flag is cleared and the next cleanup
 * classifies it again. Does not change the project's cleanup flag.
 */
export async function setKeywordRelevance(
  pool: Pool,
  { projectId, keywordId, status }: { projectId: number; keywordId: number; status: RelevanceStatus | null },
): Promise<void> {
  if (status !== null && !isRelevanceStatus(status)) throw new RelevanceError('Неизвестный статус релевантности.')
  const { rowCount } =
    status === null
      ? await pool.query(
          `UPDATE keywords SET relevance_status = NULL, relevance_confidence = NULL, relevance_reason = NULL,
                  relevance_manual = false, relevance_checked_at = NULL
           WHERE id = $1 AND project_id = $2`,
          [keywordId, projectId],
        )
      : await pool.query(
          `UPDATE keywords SET relevance_status = $3, relevance_confidence = NULL, relevance_reason = 'Решение пользователя',
                  relevance_manual = true, relevance_checked_at = now()
           WHERE id = $1 AND project_id = $2`,
          [keywordId, projectId, status],
        )
  if (!rowCount) throw new RelevanceError('Запрос не найден в этом проекте.')
}
