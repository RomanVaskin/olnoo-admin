import { istraArtDeleteAccess, deleteIstraArtMaterial } from '@/lib/istraart-delete'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getItem, editGeneratedContent, setItemStatus, approvePartnerCopy, isTrustedCopy, canApprove, canReject } from '@/lib/content-factory-items'

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

  if (typeof body.ownBrief === 'string') {
    if (item.originKind !== 'own' || body.ownBrief.length > 10000) return NextResponse.json({ error: 'Invalid own material brief.' }, { status: 422 })
    const updated = await pool.query(`UPDATE content_factory_items SET own_brief = $1, updated_at = now()
      WHERE id = $2 AND project_id = $3 AND origin_kind = 'own' AND status IN ('new', 'failed')
        AND social_post_id IS NULL AND en_social_post_id IS NULL AND en_publish_claimed = false RETURNING id`, [body.ownBrief, id, projectId])
    return updated.rowCount ? NextResponse.json(await getItem(pool, projectId, id)) : NextResponse.json({ error: 'The brief cannot be changed after preparation starts.' }, { status: 409 })
  }

  if (body.action === 'approve') {
    if (!canApprove(item.status)) return NextResponse.json({ error: `Cannot approve from status "${item.status}".` }, { status: 409 })
    if (item.processingMode === 'copy') {
      if (body.confirmOriginalTextComplete !== true && !isTrustedCopy(item)) return NextResponse.json({ error: 'Compare the public preview with the original Telegram post and confirm the text is complete before approving.' }, { status: 422 })
      if (item.originalImageUrls.length > 0 && body.confirmImageRights !== true && !isTrustedCopy(item)) return NextResponse.json({ error: 'Confirm permission to use the source images before approving.' }, { status: 422 })
      const approved = await approvePartnerCopy(pool, projectId, id, body.confirmImageRights === true || isTrustedCopy(item))
      if (!approved) return NextResponse.json({ error: 'Partner copy is incomplete, unlicensed, or changed. Refresh the material.' }, { status: 409 })
      return NextResponse.json(approved)
    }
    return NextResponse.json(await setItemStatus(pool, projectId, id, { status: 'ready' }))
  }
  if (body.action === 'reject') {
    if (!canReject(item.status)) return NextResponse.json({ error: `Cannot reject from status "${item.status}".` }, { status: 409 })
    return NextResponse.json(await setItemStatus(pool, projectId, id, { status: 'rejected' }))
  }

  if (typeof body.title === 'string' || typeof body.text === 'string') {
    if (item.processingMode === 'copy') return NextResponse.json({ error: 'Partner copy cannot be edited; use AI mode for a rewrite.' }, { status: 409 })
    if (item.socialPostId || item.enSocialPostId || item.enPublishClaimed || item.status === 'scheduled' || item.status === 'processing') return NextResponse.json({ error: 'A linked or publishing post cannot be edited. Published versions remain unchanged.' }, { status: 409 })
    const title = typeof body.title === 'string' ? body.title : item.generatedTitle
    const text = typeof body.text === 'string' ? body.text : item.generatedText
    const updated = await editGeneratedContent(pool, projectId, id, { title, text })
    return updated ? NextResponse.json(updated) : NextResponse.json({ error: 'The material changed. Reload it.' }, { status: 409 })
  }

  return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
}

/** Destructive owner-only operation, behind the existing Admin Basic Auth proxy. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = istraArtDeleteAccess(req)
  if (denied) return denied
  const projectId = await resolveProjectId('istraart')
  if (!projectId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const result = await deleteIstraArtMaterial(pool, projectId, id)
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
}
