import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { listCommentsForProject } from '@/lib/social-comments'

// Read-only, project-scoped — same isolation guarantee as every other Social module endpoint.
// No "all projects" mode, same deliberate simplicity as /api/ads (see OLNOO_PROJECT_MAP.md's
// "Ads" section): one explicit project slug is required just to list.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectId = await resolveProjectId(searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const rows = await listCommentsForProject(pool, projectId)
  return NextResponse.json(rows)
}
