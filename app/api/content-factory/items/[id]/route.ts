import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem, editGeneratedContent, setItemStatus, canApprove, canReject } from '@/lib/content-factory-items'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const item = await getItem(pool, projectId, id)
  if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(item)
}

/**
 * Edit the prepared text, or transition status to 'ready' (approve) / 'rejected' (reject) — the
 * ONLY writes this route allows. Never accepts `generatedText`/`title` together with a status
 * transition that doesn't also go through the pure `canApprove`/`canReject` guards (also used by
 * the UI to decide which buttons to show at all), so a stale client never sneaks past a state the
 * item has since moved out of (e.g. approving an item that was already published in the meantime).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const item = await getItem(pool, projectId, id)
  if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  if (body.action === 'approve') {
    if (!canApprove(item.status)) return NextResponse.json({ error: `Cannot approve from status "${item.status}".` }, { status: 409 })
    return NextResponse.json(await setItemStatus(pool, projectId, id, { status: 'ready' }))
  }
  if (body.action === 'reject') {
    if (!canReject(item.status)) return NextResponse.json({ error: `Cannot reject from status "${item.status}".` }, { status: 409 })
    return NextResponse.json(await setItemStatus(pool, projectId, id, { status: 'rejected' }))
  }

  if (typeof body.title === 'string' || typeof body.text === 'string') {
    const title = typeof body.title === 'string' ? body.title : item.generatedTitle
    const text = typeof body.text === 'string' ? body.text : item.generatedText
    return NextResponse.json(await editGeneratedContent(pool, projectId, id, { title, text }))
  }

  return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
}
