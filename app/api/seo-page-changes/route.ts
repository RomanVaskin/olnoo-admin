import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getProject } from '@/lib/projects-registry'
import { listPageChanges } from '@/lib/seo-page-changes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/seo-page-changes?projectId=<id> — the before/after history of one project (newest first). Read-only: the database only,
 * no external API, no writes. Records are created by the SEO Executor (pr_created) and closed by the next manual Observer run.
 */
export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get('projectId'))
  const project = Number.isInteger(id) && id > 0 ? await getProject(pool, id) : null
  if (!project || project.archived_at) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  return NextResponse.json({ projectId: project.id, changes: await listPageChanges(pool, project.id) })
}
