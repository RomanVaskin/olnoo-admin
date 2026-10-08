import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getProject } from '@/lib/projects-registry'
import { listPageChanges } from '@/lib/seo-page-changes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** SEO Before/After history (step F), read-only: GET ?projectId= → { changes } from `page_changes` + the stored snapshots. No external API, no writes. */
export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get('projectId'))
  const project = Number.isInteger(id) && id > 0 ? await getProject(pool, id) : null
  if (!project || project.archived_at) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  return NextResponse.json({ projectId: project.id, changes: await listPageChanges(pool, project.id) })
}
