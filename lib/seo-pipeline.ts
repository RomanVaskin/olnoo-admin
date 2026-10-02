import type { Pool } from 'pg'
import { ClusteringError, createClusteringJob, runClusteringJob, viewClusteringJob, type ClusteringJob, type ClusteringJobView, type ClusteringOptions } from './seo-clustering.ts'
import {
  createRelevanceJob,
  getRelevanceJob,
  getRelevanceSummary,
  runRelevanceJob,
  trackRelevanceJob,
  viewRelevanceJob,
  type RelevanceJob,
  type RelevanceJobView,
  type RelevanceOptions,
} from './keywords-relevance.ts'

// The one «Кластеризовать» action: cleanup of the not-yet-checked keywords (only if there are any),
// then the existing clustering run. Orchestration only — cleanup and clustering keep their own
// jobs, batching, resume, thresholds and manual-override rules; clustering still reads the live
// relevance status when it starts, so uncertain / irrelevant / geo_mismatch simply stay out.

export type PipelineStage = 'cleanup' | 'clustering' | 'done'
export type PipelineStatus = 'running' | 'failed' | 'done'

export type ClusterPipeline = {
  projectId: number
  status: PipelineStatus
  stage: PipelineStage
  /** Where it stopped when `status` is 'failed'. */
  failedIn: 'cleanup' | 'clustering' | null
  /** «Продолжить» makes sense: a failed batch to redo (false for e.g. «nothing eligible to cluster»). */
  resumable: boolean
  error: string | null
  /** Present when this run had keywords to check. */
  cleanup: RelevanceJob | null
  clustering: ClusteringJob | null
  /** After a finished run: keywords still waiting for a human («Требуют проверки») / not returned by the AI. */
  uncertainLeft: number | null
  unclassifiedLeft: number | null
  /** `cleanup` is a run already started elsewhere (cleanup screen): wait for it instead of starting one. */
  attached: boolean
  startedAt: string
}

export type ClusterPipelineView = {
  projectId: number
  status: PipelineStatus
  stage: PipelineStage
  failedIn: 'cleanup' | 'clustering' | null
  resumable: boolean
  error: string | null
  cleanup: RelevanceJobView | null
  clustering: ClusteringJobView | null
  uncertainLeft: number | null
  unclassifiedLeft: number | null
}

export type PipelineOptions = ClusteringOptions & {
  /** Keywords per cleanup AI call (tests); production uses the cleanup default. */
  relevanceBatchSize?: number
}

export function viewClusterPipeline(p: ClusterPipeline): ClusterPipelineView {
  return {
    projectId: p.projectId,
    status: p.status,
    stage: p.stage,
    failedIn: p.failedIn,
    resumable: p.resumable,
    error: p.error,
    cleanup: p.cleanup ? viewRelevanceJob(p.cleanup) : null,
    clustering: p.clustering ? viewClusteringJob(p.clustering) : null,
    uncertainLeft: p.uncertainLeft,
    unclassifiedLeft: p.unclassifiedLeft,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(p: ClusterPipeline, failedIn: 'cleanup' | 'clustering', error: string | null, resumable: boolean) {
  p.status = 'failed'
  p.failedIn = failedIn
  p.resumable = resumable
  p.error = error
}

/** Plans a run: a cleanup job when keywords are unclassified, otherwise straight to clustering. */
export async function createClusterPipeline(pool: Pool, projectId: number, opts: PipelineOptions = {}): Promise<ClusterPipeline> {
  const summary = await getRelevanceSummary(pool, projectId)
  if (summary.total === 0) {
    throw new ClusteringError('This project has no keywords to cluster yet — import Wordstat data first.')
  }
  const needsCleanup = summary.unclassified > 0
  const cleanup = needsCleanup ? await createRelevanceJob(pool, projectId, { batchSize: opts.relevanceBatchSize }) : null
  // No cleanup needed: plan clustering now so "nothing eligible" is reported at once.
  const clustering = needsCleanup ? null : await createClusteringJob(pool, projectId, opts)
  return {
    projectId,
    status: 'running',
    stage: needsCleanup ? 'cleanup' : 'clustering',
    failedIn: null,
    resumable: false,
    error: null,
    cleanup,
    clustering,
    uncertainLeft: null,
    unclassifiedLeft: null,
    attached: false,
    startedAt: new Date().toISOString(),
  }
}

/**
 * Runs (or resumes) the chain. Cleanup first — a failed cleanup batch stops the chain, nothing is
 * clustered; resuming redoes only the failed batches and then continues with clustering. After a
 * finished cleanup clustering always runs: uncertain keywords never block it, they are just not
 * in its input.
 */
export async function runClusterPipeline(pool: Pool, p: ClusterPipeline, opts: PipelineOptions = {}): Promise<ClusterPipeline> {
  p.status = 'running'
  p.error = null
  p.failedIn = null
  p.resumable = false
  try {
    if (p.cleanup && p.cleanup.status !== 'done') {
      p.stage = 'cleanup'
      if (p.attached) {
        // A cleanup started from the cleanup screen is already running: wait for it instead of racing it.
        while (p.cleanup.status === 'running') await sleep(500)
        p.attached = false
      } else {
        // Fresh job, or a failed one being resumed: runs only the pending / failed batches.
        await runRelevanceJob(pool, p.cleanup, { llm: opts.llm, concurrency: opts.concurrency, batchSize: opts.relevanceBatchSize } satisfies RelevanceOptions)
      }
      if (p.cleanup.status === 'failed') {
        fail(p, 'cleanup', p.cleanup.error, true)
        return p
      }
    }

    p.stage = 'clustering'
    if (!p.clustering) {
      try {
        p.clustering = await createClusteringJob(pool, p.projectId, opts)
      } catch (err) {
        if (!(err instanceof ClusteringError)) throw err
        fail(p, 'clustering', err.message, false)
        return p
      }
    }
    if (p.clustering.status !== 'done') {
      await runClusteringJob(pool, p.clustering, opts)
      if (p.clustering.status === 'failed') {
        fail(p, 'clustering', p.clustering.error, true)
        return p
      }
    }

    const summary = await getRelevanceSummary(pool, p.projectId)
    p.uncertainLeft = summary.uncertain
    p.unclassifiedLeft = summary.unclassified
    p.stage = 'done'
    p.status = 'done'
  } catch (err) {
    fail(p, p.stage === 'cleanup' ? 'cleanup' : 'clustering', err instanceof Error ? err.message : String(err), false)
  }
  return p
}

/** Synchronous plan + run for tests and scripts; throws when the chain does not finish. */
export async function clusterProject(pool: Pool, projectId: number, opts: PipelineOptions = {}): Promise<ClusterPipeline> {
  const p = await runClusterPipeline(pool, await createClusterPipeline(pool, projectId, opts), opts)
  if (p.status !== 'done') throw new ClusteringError(p.error ?? 'Clustering failed.')
  return p
}

// One pipeline per project in the memory of the single OLNOO Admin process (globalThis survives dev HMR).
const pipelines: Map<number, ClusterPipeline> = ((globalThis as { __olnooClusterPipelines?: Map<number, ClusterPipeline> }).__olnooClusterPipelines ??=
  new Map())

export function getClusterPipeline(projectId: number): ClusterPipeline | null {
  return pipelines.get(projectId) ?? null
}

/**
 * Starts the chain in the background, or returns the one already running. `resume` continues a
 * failed run (its failed cleanup / clustering batches), then goes on to the next stage.
 */
export async function startClusterPipeline(pool: Pool, projectId: number, { resume = false }: { resume?: boolean } = {}): Promise<ClusterPipeline> {
  const existing = pipelines.get(projectId)
  if (existing?.status === 'running') return existing
  const p = resume && existing?.status === 'failed' && existing.resumable ? existing : await createClusterPipeline(pool, projectId)
  if (p !== existing) {
    pipelines.set(projectId, p)
    // Show an already running cleanup (started from the cleanup screen) as this pipeline's first stage.
    const running = getRelevanceJob(projectId)
    if (p.cleanup && running?.status === 'running') {
      p.cleanup = running
      p.attached = true
    } else if (p.cleanup) {
      trackRelevanceJob(p.cleanup)
    }
  }
  void runClusterPipeline(pool, p).catch((err) => fail(p, p.stage === 'cleanup' ? 'cleanup' : 'clustering', err instanceof Error ? err.message : String(err), false))
  return p
}
