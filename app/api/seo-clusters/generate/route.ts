import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { RelevanceError } from '@/lib/keywords-relevance'
import { ClusteringError } from '@/lib/seo-clustering'
import { getClusterPipeline, startClusterPipeline, viewClusterPipeline } from '@/lib/seo-pipeline'

/**
 * The single «Кластеризовать» action. Starts, in the background, the chain: cleanup of the
 * not-yet-checked keywords (only if there are any) → clustering (or returns the run in progress);
 * `resume: true` continues a failed run — its failed batches — and then goes on to the next stage.
 * Answers at once; the UI polls GET, so a multi-minute run never hits an HTTP/proxy timeout.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const projectId = Number(body?.projectId)

  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }

  try {
    const pipeline = await startClusterPipeline(pool, projectId, { resume: body?.resume === true })
    return NextResponse.json({ pipeline: viewClusterPipeline(pipeline) }, { status: 202 })
  } catch (err) {
    if (err instanceof ClusteringError || err instanceof RelevanceError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error('seo-clusters/generate failed', err)
    return NextResponse.json({ error: 'Clustering failed. Please try again.' }, { status: 500 })
  }
}

/** Progress of the project's latest run (null when none ran since the server started). */
export async function GET(req: Request) {
  const projectId = Number(new URL(req.url).searchParams.get('projectId'))
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }
  const pipeline = getClusterPipeline(projectId)
  return NextResponse.json({ pipeline: pipeline ? viewClusterPipeline(pipeline) : null })
}
