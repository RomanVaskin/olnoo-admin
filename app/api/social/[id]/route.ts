import { NextResponse } from 'next/server'
import { deleteSocialPost, getSocialPost, updateSocialPost } from '@/lib/social'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')

  const post = await getSocialPost(id, project)
  if (!post) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(post)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid request' }, { status: 400 })

  const result = await updateSocialPost(id, project, {
    topic: typeof body.topic === 'string' ? body.topic : undefined,
    category: typeof body.category === 'string' ? body.category : undefined,
    body: typeof body.body === 'string' ? body.body : undefined,
    telegramText: typeof body.telegramText === 'string' ? body.telegramText : undefined,
    instagramText: typeof body.instagramText === 'string' ? body.instagramText : undefined,
    threadsText: typeof body.threadsText === 'string' ? body.threadsText : undefined,
    vkText: typeof body.vkText === 'string' ? body.vkText : undefined,
    channels: Array.isArray(body.channels) ? body.channels : undefined,
    publishDate: typeof body.publishDate === 'string' ? body.publishDate : undefined,
    status: typeof body.status === 'string' ? body.status : undefined,
  })

  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row)
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')

  const deleted = await deleteSocialPost(id, project)
  if (!deleted) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
