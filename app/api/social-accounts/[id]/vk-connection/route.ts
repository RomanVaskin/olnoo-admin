import { NextResponse } from 'next/server'
import { connectOrRecheckVkAccount } from '@/lib/social-accounts-vk-connection'

// Connects a VK community's own access token to this social_accounts row (body { accessToken }),
// or re-checks the one already stored (empty body / no accessToken) — see
// lib/social-accounts-vk-connection.ts. The token itself is never echoed back in the response.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const body = await req.json().catch(() => ({}))
  const accessToken = typeof body?.accessToken === 'string' && body.accessToken.trim() ? body.accessToken : null

  const result = await connectOrRecheckVkAccount(id, project, accessToken)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row)
}
