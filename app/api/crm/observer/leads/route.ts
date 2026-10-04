import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { parseObserverQuery, readLeadsForPeriod } from '@/lib/crm-observer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * CRM Observer — READ-ONLY slice of one project's leads for a period (Ads Agent pipeline: Direct Observer →
 * CRM read-only → Metrika → unified analytics). GET only: this file exports no other method and the data
 * layer issues a single SELECT. No application-level auth (the app has none); in production admin.olnoo.com sits
 * behind an external access layer (see OLNOO_PROJECT_MAP.md, "Access to admin.olnoo.com").
 *
 * GET /api/crm/observer/leads?project=<slug>&from=YYYY-MM-DD&to=YYYY-MM-DD
 * from/to are inclusive calendar days in Europe/Moscow (same as the Direct Observer's period).
 */
export async function GET(req: Request) {
  const parsed = parseObserverQuery(new URL(req.url).searchParams)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: parsed.status })

  try {
    const result = await readLeadsForPeriod(pool, parsed)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result)
  } catch {
    // No error detail is logged or returned: lead rows contain personal data.
    console.error('[crm-observer] query failed')
    return NextResponse.json({ error: 'CRM read failed' }, { status: 500 })
  }
}
