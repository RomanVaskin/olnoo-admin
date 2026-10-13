import { NextResponse } from 'next/server'
import { connectOrRecheckThreadsAccount } from '@/lib/social-accounts-threads-connection'

// Connects a Threads account's own access token to this social_accounts row (body
// { accessToken }), or re-checks the one already stored (empty body / no accessToken) — see
// lib/social-accounts-threads-connection.ts. The token itself is never echoed back.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const body = await req.json().catch(() => ({}))
  const accessToken = typeof body?.accessToken === 'string' && body.accessToken.trim() ? body.accessToken : null

  const result = await connectOrRecheckThreadsAccount(id, project, accessToken)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row)
}
