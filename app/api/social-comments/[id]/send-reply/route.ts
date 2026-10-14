import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { sendCommentReply } from '@/lib/social-comment-reply'

// The only place in this feature that ever calls Telegram — only ever reached after a human
// clicks "Отправить" on the (possibly hand-edited) suggested text in the UI; nothing here is
// triggered automatically. Project-scoped like every other Social module endpoint.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const projectId = await resolveProjectId(searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const payload = await req.json().catch(() => null)
  const text = typeof payload?.text === 'string' ? payload.text : ''

  try {
    const result = await sendCommentReply(pool, projectId, id, text)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.row)
  } catch (err) {
    console.error('social-comments/send-reply failed', err)
    return NextResponse.json({ error: 'Could not send the reply. Please try again.' }, { status: 500 })
  }
}
