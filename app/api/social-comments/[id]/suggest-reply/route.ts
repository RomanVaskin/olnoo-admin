import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { suggestCommentReply } from '@/lib/social-comment-reply'

// Read-only: never writes anything, never sends anything to Telegram — "Предложить ответ" and
// "Сгенерировать заново" are both just this same call again. Project-scoped like every other
// Social module endpoint; a comment id from another project resolves as not-found.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const projectId = await resolveProjectId(searchParams.get('project'))
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  try {
    const result = await suggestCommentReply(pool, projectId, id)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ reply: result.reply })
  } catch (err) {
    console.error('social-comments/suggest-reply failed', err)
    return NextResponse.json({ error: 'Could not generate a reply suggestion. Please try again.' }, { status: 500 })
  }
}
