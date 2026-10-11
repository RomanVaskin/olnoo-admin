import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { createLeadRecord, resolveProjectId } from '@/lib/crm'
import { resolveLeadsProjectFilter, wantsAllProjects } from '@/lib/leads-project-filter'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectParam = searchParams.get('project')
  const resolvedProjectId = wantsAllProjects(projectParam) ? null : await resolveProjectId(projectParam)
  const filter = resolveLeadsProjectFilter(projectParam, resolvedProjectId)

  if (filter.kind === 'none') return NextResponse.json([])
  if (filter.kind === 'one') {
    const { rows } = await pool.query(LEADS_SELECT + ' WHERE l.project_id = $1 ORDER BY l.created_at DESC', [filter.projectId])
    return NextResponse.json(rows)
  }
  const { rows } = await pool.query(LEADS_SELECT + ' ORDER BY l.created_at DESC')
  return NextResponse.json(rows)
}

const LEADS_SELECT = `
  SELECT
    l.id, l.project_id, l.name, l.company, l.email, l.phone, l.contact, l.service, l.message,
    l.source, l.landing_page, l.referrer, l.utm_source, l.utm_medium, l.utm_campaign,
    l.locale, l.status, l.notes, l.created_at, l.updated_at,
    l.traffic_class_auto, l.traffic_class_reason, l.traffic_class_override, l.traffic_class_override_at,
    p.slug AS project_slug, p.name AS project_name
  FROM leads l
  JOIN projects p ON p.id = l.project_id
`

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body.name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const result = await createLeadRecord({
    project: typeof body.project === 'string' ? body.project : null,
    name: body.name,
    email: typeof body.email === 'string' ? body.email : '',
    company: typeof body.company === 'string' ? body.company : undefined,
    service: typeof body.service === 'string' ? body.service : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    source: typeof body.source === 'string' ? body.source : 'manual',
    notes: typeof body.notes === 'string' ? body.notes : undefined,
  })

  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row, { status: 201 })
}
