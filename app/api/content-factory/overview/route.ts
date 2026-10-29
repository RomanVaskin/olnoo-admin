import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { listSources } from '@/lib/content-factory-sources'
import { countItemsByStatus } from '@/lib/content-factory-items'

export async function GET(req: Request) {
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const sources = await listSources(pool, projectId)
  const byStatus = await countItemsByStatus(pool, projectId)
  const found = Object.values(byStatus).reduce((sum, n) => sum + n, 0)
  const created = (byStatus.ready ?? 0) + (byStatus.scheduled ?? 0) + (byStatus.published ?? 0) + (byStatus.needs_review ?? 0)
  const published = byStatus.published ?? 0
  const errors = (byStatus.failed ?? 0) + sources.filter((s) => s.lastError).length

  return NextResponse.json({
    sourcesCount: sources.length,
    found,
    created,
    published,
    errors,
    byStatus,
  })
}
