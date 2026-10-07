import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { createProject, listProjects, type ArchivedFilter } from '@/lib/projects-registry'

/**
 * THE project list of the Admin (lib/projects-registry.ts). Active projects by default; archived ones only on an explicit
 * request: `?archived=include` (all) or `?archived=only`. Every project-based screen and check reads this, not its own list.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('archived')
  const archived: ArchivedFilter = q === 'include' ? 'include' : q === 'only' ? 'only' : 'exclude'
  return NextResponse.json(await listProjects(pool, { archived }))
}

/** Create a project (active immediately). Body: { name, domain, slug?, sitemapUrl?, locale?, clientId? }. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'JSON body is required' }, { status: 400 })
  const result = await createProject(pool, body)
  return result.ok ? NextResponse.json(result.project, { status: 201 }) : NextResponse.json({ error: result.error }, { status: result.status })
}
