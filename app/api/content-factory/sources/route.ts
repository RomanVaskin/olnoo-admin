import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { listSources, createSource, ContentFactorySourceError } from '@/lib/content-factory-sources'

export async function GET(req: Request) {
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  return NextResponse.json(await listSources(pool, projectId))
}

export async function POST(req: Request) {
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body.type !== 'string' || typeof body.handle !== 'string') {
    return NextResponse.json({ error: 'type and handle are required' }, { status: 400 })
  }
  try {
    const source = await createSource(pool, projectId, { type: body.type, handle: body.handle })
    return NextResponse.json(source, { status: 201 })
  } catch (err) {
    if (err instanceof ContentFactorySourceError) return NextResponse.json({ error: err.message }, { status: 422 })
    console.error('content-factory/sources create failed', err)
    return NextResponse.json({ error: 'Could not create the source. Please try again.' }, { status: 500 })
  }
}
