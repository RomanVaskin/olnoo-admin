import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { updateSource, deleteSource, ContentFactorySourceError } from '@/lib/content-factory-sources'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const body = await req.json().catch(() => null)
  try {
    const source = await updateSource(pool, projectId, id, {
      handle: typeof body?.handle === 'string' ? body.handle : undefined,
      enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
    })
    if (!source) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json(source)
  } catch (err) {
    if (err instanceof ContentFactorySourceError) return NextResponse.json({ error: err.message }, { status: 422 })
    console.error('content-factory/sources update failed', err)
    return NextResponse.json({ error: 'Could not update the source. Please try again.' }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const ok = await deleteSource(pool, projectId, id)
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
