import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { ClusterReviewError, listClustersForProject, updateClusterReview, type ReviewStatus } from '@/lib/seo-clustering'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectId = Number(searchParams.get('projectId'))

  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }

  const clusters = await listClustersForProject(pool, projectId)
  return NextResponse.json(clusters)
}

const REVIEW_STATUSES: ReviewStatus[] = ['confirmed', 'no_page', 'ignored']

/**
 * Records a human review decision for one cluster: confirm the AI-recommended page or
 * another existing page (reviewStatus 'confirmed' + pageId), or mark it 'no_page' / 'ignored'.
 * Leaves seo_clusters.status (the AI's own classification), keyword_pages, and the SEO Map
 * untouched — cluster review is a separate layer for now.
 */
export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null)
  const clusterId = Number(body?.clusterId)
  const projectId = Number(body?.projectId)
  const reviewStatus = body?.reviewStatus as ReviewStatus
  const pageId = body?.pageId === null || body?.pageId === undefined ? null : Number(body.pageId)

  if (!Number.isInteger(clusterId) || !Number.isInteger(projectId)) {
    return NextResponse.json({ error: 'clusterId and projectId are required' }, { status: 400 })
  }
  if (!REVIEW_STATUSES.includes(reviewStatus)) {
    return NextResponse.json({ error: 'reviewStatus must be one of: confirmed, no_page, ignored' }, { status: 400 })
  }
  if (reviewStatus === 'confirmed' && !Number.isInteger(pageId)) {
    return NextResponse.json({ error: 'pageId is required when reviewStatus is confirmed' }, { status: 400 })
  }

  try {
    await updateClusterReview(pool, { clusterId, projectId, reviewStatus, pageId })
  } catch (err) {
    if (err instanceof ClusterReviewError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error('seo-clusters PATCH failed', err)
    return NextResponse.json({ error: 'Failed to update cluster review.' }, { status: 500 })
  }

  const clusters = await listClustersForProject(pool, projectId)
  return NextResponse.json(clusters)
}
