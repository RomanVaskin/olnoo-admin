import { NextResponse } from 'next/server'
import { deleteAdsCampaign, getAdsCampaign, updateAdsCampaign } from '@/lib/ads'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')

  const campaign = await getAdsCampaign(id, project)
  if (!campaign) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(campaign)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid request' }, { status: 400 })

  const result = await updateAdsCampaign(id, project, {
    platform: typeof body.platform === 'string' ? body.platform : undefined,
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
  return NextResponse.json(result.row)
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const project = searchParams.get('project')

  const deleted = await deleteAdsCampaign(id, project)
  if (!deleted) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
