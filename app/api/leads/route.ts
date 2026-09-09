import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { createLeadRecord, resolveProjectId } from '@/lib/crm'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectId = await resolveProjectId(searchParams.get('project'))

  const { rows } = await pool.query(
    `
    SELECT
      l.id, l.project_id, l.name, l.company, l.email, l.service, l.message,
      l.source, l.landing_page, l.referrer, l.utm_source, l.utm_medium, l.utm_campaign,
      l.locale, l.status, l.notes, l.created_at, l.updated_at,
      p.slug AS project_slug, p.name AS project_name
    FROM leads l
    JOIN projects p ON p.id = l.project_id
    WHERE ($1::int IS NULL OR l.project_id = $1::int)
    ORDER BY l.created_at DESC
    `,
    [projectId],
  )
  return NextResponse.json(rows)
}

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
