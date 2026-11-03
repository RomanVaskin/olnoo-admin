import { NextResponse } from 'next/server.js'
import { checkAiRouterProvider, isAiRouterProvider, isAiRouterSuperAdmin, readAiRouterCatalog, updateAiRouterPreset } from '../../../lib/ai-router-admin.ts'

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
  if (body?.action === 'setPreset') {
    if (!['content-factory.text', 'content-factory.review'].includes(body?.key) ||
        !isAiRouterProvider(body?.provider) || typeof body?.model !== 'string' ||
        body.model.length < 1 || body.model.length > 128) {
      return NextResponse.json({ error: 'Invalid model selection.' }, { status: 400, headers: noStore })
    }
    try {
      return NextResponse.json(await updateAiRouterPreset({
        key: body.key,
        provider: body.provider,
        model: body.model,
      }), { headers: noStore })
    } catch {
      return NextResponse.json({ error: 'Could not save AI Router model selection.' }, { status: 502, headers: noStore })
    }
  }
  if (!isAiRouterProvider(body?.provider) || body?.action !== undefined) {
    return NextResponse.json({ error: 'Unknown provider.' }, { status: 400, headers: noStore })
  }
  try {
    return NextResponse.json(await checkAiRouterProvider(body.provider), { headers: noStore })
  } catch {
    return NextResponse.json({ error: 'Provider check is unavailable.' }, { status: 502, headers: noStore })
  }
}
