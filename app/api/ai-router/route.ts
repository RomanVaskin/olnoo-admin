import { NextResponse } from 'next/server.js'
import { checkAiRouterProvider, isAiRouterProvider, isAiRouterSuperAdmin, readAiRouterCatalog } from '../../../lib/ai-router-admin.ts'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  if (!isAiRouterSuperAdmin(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: noStore })
  try {
    return NextResponse.json(await readAiRouterCatalog(), { headers: noStore })
  } catch {
    return NextResponse.json({ error: 'AI Router catalog is unavailable.' }, { status: 502, headers: noStore })
  }
}

export async function POST(req: Request) {
  if (!isAiRouterSuperAdmin(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: noStore })
  const body = await req.json().catch(() => null)
  if (!isAiRouterProvider(body?.provider)) return NextResponse.json({ error: 'Unknown provider.' }, { status: 400, headers: noStore })
  try {
    return NextResponse.json(await checkAiRouterProvider(body.provider), { headers: noStore })
  } catch {
    return NextResponse.json({ error: 'Provider check is unavailable.' }, { status: 502, headers: noStore })
  }
}
