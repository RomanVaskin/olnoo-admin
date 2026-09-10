import { NextResponse } from 'next/server'
import { createSocialAccount, listSocialAccounts } from '@/lib/social-accounts'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const platform = searchParams.get('platform') ?? undefined

  const rows = await listSocialAccounts(project, { platform })
  if (rows === null) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  return NextResponse.json(rows)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body.platform !== 'string') {
    return NextResponse.json({ error: 'platform is required' }, { status: 400 })
  }

  const result = await createSocialAccount(typeof body.project === 'string' ? body.project : null, {
    platform: body.platform,
    name: typeof body.name === 'string' ? body.name : undefined,
    username: typeof body.username === 'string' ? body.username : undefined,
    publicUrl: typeof body.publicUrl === 'string' ? body.publicUrl : undefined,
    status: typeof body.status === 'string' ? body.status : undefined,
    active: typeof body.active === 'boolean' ? body.active : undefined,
    notes: typeof body.notes === 'string' ? body.notes : undefined,
  })

  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row, { status: 201 })
}
