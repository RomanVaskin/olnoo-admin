import { NextResponse } from 'next/server'
import { createLeadRecord } from '@/lib/crm'

/**
 * Server-to-server lead intake for public OLNOO-family sites (e.g. olnoo.com's
 * contact form). Requires OLNOO_CRM_API_KEY — never exposed to any browser —
 * so this is not an open write endpoint despite being reachable from the
 * public internet. Distinct from /api/leads, which the Admin UI itself uses.
 */
export async function POST(req: Request) {
  const expected = process.env.OLNOO_CRM_API_KEY
  if (!expected) {
    return NextResponse.json({ error: 'CRM inbound API is not configured' }, { status: 503 })
  }

  const auth = req.headers.get('authorization') ?? ''
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
    source: typeof body.source === 'string' ? body.source : undefined,
  })

  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.row, { status: 201 })
}
