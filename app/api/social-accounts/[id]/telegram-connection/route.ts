import { NextResponse } from 'next/server'
import { connectOrRecheckTelegramAccount } from '@/lib/social-accounts-telegram-connection'

// Connects a Telegram channel (body { username }, a handle or numeric chat id) to this
// social_accounts row by verifying the existing shared bot can post there, or re-checks the one
// already stored (empty body / no username) — see lib/social-accounts-telegram-connection.ts.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const body = await req.json().catch(() => ({}))
  const username = typeof body?.username === 'string' && body.username.trim() ? body.username : null

  const result = await connectOrRecheckTelegramAccount(id, project, username)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row)
}
