import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { ClusterAiReviewError, getClusterReviewJob, startClusterReview } from '@/lib/seo-cluster-review'

/**
 * «AI проверить все кластеры»: starts, in the background, the CREATE / IMPROVE / IGNORE review of the project's
 * pending clusters (BULK route: DeepSeek, no fallback). Only prepares decisions — no page is created. Answers at
 * once; the UI polls GET. Calling it again continues with the clusters that are still undecided.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const projectId = Number(body?.projectId)
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }
  try {
    const job = await startClusterReview(pool, projectId, { force: body?.force === true })
    return NextResponse.json({ job }, { status: 202 })
  } catch (err) {
    if (err instanceof ClusterAiReviewError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    if ((err as { code?: string }).code === '42703') {
      return NextResponse.json({ error: 'Apply migration 0014_cluster_ai_review.sql first.' }, { status: 409 })
    }
    console.error('seo-clusters/review failed', err)
    return NextResponse.json({ error: 'AI review failed. Please try again.' }, { status: 500 })
  }
}

/** Progress of the project's latest AI review (null when none ran since the server started). */
export async function GET(req: Request) {
  const projectId = Number(new URL(req.url).searchParams.get('projectId'))
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }
  return NextResponse.json({ job: getClusterReviewJob(projectId) })
}
