import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { normalizeSource, resolveProjectId } from '@/lib/crm'

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
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (typeof body.email !== 'string' || !/^\S+@\S+\.\S+$/.test(body.email)) {
    return NextResponse.json({ error: 'a valid email is required' }, { status: 400 })
  }

  const projectId = await resolveProjectId(typeof body.project === 'string' ? body.project : null)
  if (!projectId) {
    return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  }

  const id = randomUUID()
  const { rows } = await pool.query(
    `
    INSERT INTO leads (
      id, project_id, name, company, email, service, message, source, status, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'New', $9)
    RETURNING *
    `,
    [
      id,
      projectId,
      body.name.trim(),
      typeof body.company === 'string' ? body.company.trim() : '',
      body.email.trim(),
      typeof body.service === 'string' ? body.service.trim() : '',
      typeof body.message === 'string' ? body.message : '',
      normalizeSource(typeof body.source === 'string' ? body.source : 'manual'),
      typeof body.notes === 'string' ? body.notes : '',
    ],
  )
  return NextResponse.json(rows[0], { status: 201 })
}
