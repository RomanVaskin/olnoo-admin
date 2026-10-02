import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { ClusteringError, getClusteringJob, startClusteringJob, viewClusteringJob } from '@/lib/seo-clustering'

/**
 * Starts AI clustering for a project in the background (or returns the run already in progress);
 * `resume: true` continues a failed run, reusing its finished batches. Answers immediately — the
 * UI polls GET for progress, so a multi-minute run never hits an HTTP/proxy timeout.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const projectId = Number(body?.projectId)

  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }

  try {
    const job = await startClusteringJob(pool, projectId, { resume: body?.resume === true })
    return NextResponse.json({ job: viewClusteringJob(job) }, { status: 202 })
  } catch (err) {
    if (err instanceof ClusteringError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error('seo-clusters/generate failed', err)
    return NextResponse.json({ error: 'Clustering failed. Please try again.' }, { status: 500 })
  }
}

/** Progress of the project's latest clustering run (null when none ran since the server started). */
export async function GET(req: Request) {
  const projectId = Number(new URL(req.url).searchParams.get('projectId'))
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }
  const job = getClusteringJob(projectId)
  return NextResponse.json({ job: job ? viewClusteringJob(job) : null })
}
