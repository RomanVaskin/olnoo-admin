import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getProject } from '@/lib/projects-registry'
import { computeSeoDecisions } from '@/lib/seo-decision-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * SEO Decision rules v1 — READ-ONLY recommendations for one project: GET only. It reads the saved Technical SEO result, the latest
 * saved Observer snapshots and the saved clusters, and runs the pure `decideSeoActions`. No provider call, no AI, no writes,
 * nothing stored. Unknown or archived project → 404.
 */
export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get('projectId'))
  const project = Number.isInteger(id) && id > 0 ? await getProject(pool, id) : null
  if (!project || project.archived_at) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  return NextResponse.json(await computeSeoDecisions(pool, project.id))
}
