import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { listClustersForProject } from '@/lib/seo-clustering'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectId = Number(searchParams.get('projectId'))

  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }

  const clusters = await listClustersForProject(pool, projectId)
  return NextResponse.json(clusters)
}
