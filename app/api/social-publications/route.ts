import { NextResponse } from 'next/server'
import { listPublicationsForPost } from '@/lib/social-publications'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const post = searchParams.get('post')
  if (!post) return NextResponse.json({ error: 'post is required' }, { status: 400 })

  const rows = await listPublicationsForPost(post, project)
  if (rows === null) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(rows)
}
