import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { listItems } from '@/lib/content-factory-items'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const status = searchParams.get('status') ?? undefined
  const sourceId = searchParams.get('sourceId') ?? undefined
  return NextResponse.json(await listItems(pool, projectId, { status, sourceId }))
}
