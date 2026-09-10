import { NextResponse } from 'next/server'
import { updateSocialPublication } from '@/lib/social-publications'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid request' }, { status: 400 })

  const result = await updateSocialPublication(id, project, {
    socialAccountId:
      body.socialAccountId === null ? null : typeof body.socialAccountId === 'string' ? body.socialAccountId : undefined,
    status: typeof body.status === 'string' ? body.status : undefined,
    externalUrl: typeof body.externalUrl === 'string' ? body.externalUrl : undefined,
    externalPostId: typeof body.externalPostId === 'string' ? body.externalPostId : undefined,
    error: typeof body.error === 'string' ? body.error : undefined,
  })

  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row)
}
