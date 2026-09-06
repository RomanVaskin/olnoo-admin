import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { ClusteringError, generateClustersForProject, listClustersForProject } from '@/lib/seo-clustering'
import { AiRouterError } from '@/lib/ai-router'

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const projectId = Number(body?.projectId)

  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }

  try {
    await generateClustersForProject(pool, projectId)
  } catch (err) {
    if (err instanceof ClusteringError || err instanceof AiRouterError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error('seo-clusters/generate failed', err)
    return NextResponse.json({ error: 'Clustering failed. Please try again.' }, { status: 500 })
  }

  const clusters = await listClustersForProject(pool, projectId)
  return NextResponse.json({ clusters })
}
