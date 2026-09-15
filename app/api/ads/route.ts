import { NextResponse } from 'next/server'
import { createAdsCampaign, listAdsCampaigns } from '@/lib/ads'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const platform = searchParams.get('platform') ?? undefined
  const status = searchParams.get('status') ?? undefined

  const rows = await listAdsCampaigns(project, { platform, status })
  if (rows === null) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  return NextResponse.json(rows)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body.platform !== 'string') {
    return NextResponse.json({ error: 'platform is required' }, { status: 400 })
  }

  const result = await createAdsCampaign(typeof body.project === 'string' ? body.project : null, {
    platform: body.platform,
    name: typeof body.name === 'string' ? body.name : undefined,
    status: typeof body.status === 'string' ? body.status : undefined,
    budget: typeof body.budget === 'number' ? body.budget : undefined,
    spend: typeof body.spend === 'number' ? body.spend : undefined,
    impressions: typeof body.impressions === 'number' ? body.impressions : undefined,
    clicks: typeof body.clicks === 'number' ? body.clicks : undefined,
    leads: typeof body.leads === 'number' ? body.leads : undefined,
    sales: typeof body.sales === 'number' ? body.sales : undefined,
    revenue: typeof body.revenue === 'number' ? body.revenue : undefined,
    utmSource: typeof body.utmSource === 'string' ? body.utmSource : undefined,
    utmMedium: typeof body.utmMedium === 'string' ? body.utmMedium : undefined,
    utmCampaign: typeof body.utmCampaign === 'string' ? body.utmCampaign : undefined,
    startedAt: typeof body.startedAt === 'string' ? body.startedAt : undefined,
    endedAt: typeof body.endedAt === 'string' ? body.endedAt : undefined,
  })

  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row, { status: 201 })
}
