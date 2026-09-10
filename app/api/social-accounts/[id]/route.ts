import { NextResponse } from 'next/server'
import { deleteSocialAccount, getSocialAccount, updateSocialAccount } from '@/lib/social-accounts'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')

  const account = await getSocialAccount(id, project)
  if (!account) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(account)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid request' }, { status: 400 })

  const result = await updateSocialAccount(id, project, {
    platform: typeof body.platform === 'string' ? body.platform : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    username: typeof body.username === 'string' ? body.username : undefined,
    publicUrl: typeof body.publicUrl === 'string' ? body.publicUrl : undefined,
    status: typeof body.status === 'string' ? body.status : undefined,
    active: typeof body.active === 'boolean' ? body.active : undefined,
    notes: typeof body.notes === 'string' ? body.notes : undefined,
  })

  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row)
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')

  const deleted = await deleteSocialAccount(id, project)
  if (!deleted) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
