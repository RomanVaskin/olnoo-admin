import { NextResponse } from 'next/server'
import { createSocialPost, listSocialPosts } from '@/lib/social'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const q = searchParams.get('q') ?? undefined
  const status = searchParams.get('status') ?? undefined

  const rows = await listSocialPosts(project, { q, status })
  if (rows === null) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  return NextResponse.json(rows)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body.topic !== 'string') {
    return NextResponse.json({ error: 'topic is required' }, { status: 400 })
  }

  const result = await createSocialPost(typeof body.project === 'string' ? body.project : null, {
    topic: body.topic,
    category: typeof body.category === 'string' ? body.category : undefined,
    body: typeof body.body === 'string' ? body.body : undefined,
    telegramText: typeof body.telegramText === 'string' ? body.telegramText : undefined,
    instagramText: typeof body.instagramText === 'string' ? body.instagramText : undefined,
    instagramImageUrl: typeof body.instagramImageUrl === 'string' ? body.instagramImageUrl : undefined,
    threadsText: typeof body.threadsText === 'string' ? body.threadsText : undefined,
    vkText: typeof body.vkText === 'string' ? body.vkText : undefined,
    channels: Array.isArray(body.channels) ? body.channels : undefined,
    publishDate: typeof body.publishDate === 'string' ? body.publishDate : undefined,
    status: typeof body.status === 'string' ? body.status : undefined,
  })

  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row, { status: 201 })
}
