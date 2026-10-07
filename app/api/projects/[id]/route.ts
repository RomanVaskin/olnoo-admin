import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { updateProject } from '@/lib/projects-registry'

/**
 * Edit a project and/or archive / restore it: { name?, domain?, sitemapUrl?, locale?, archived?: boolean }.
 * The slug cannot be changed. There is deliberately no DELETE: archiving hides the project, its data stays.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const projectId = Number(id)
  if (!Number.isInteger(projectId) || projectId < 1) return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'JSON body is required' }, { status: 400 })
  const result = await updateProject(pool, projectId, body)
  return result.ok ? NextResponse.json(result.project) : NextResponse.json({ error: result.error }, { status: result.status })
}
