import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { publishSelectedChannels } from '@/lib/social-publish-selected'

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const body = await req.json().catch(() => null)
  const postId = typeof body?.postId === 'string' ? body.postId : ''
  if (!postId) return NextResponse.json({ error: 'postId is required' }, { status: 400 })

  try {
    const result = await publishSelectedChannels(pool, postId, project)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result)
  } catch (err) {
    console.error('social-publications/publish-selected failed', err)
    return NextResponse.json({ error: 'Could not publish the selected channels. Please try again.' }, { status: 500 })
  }
}
