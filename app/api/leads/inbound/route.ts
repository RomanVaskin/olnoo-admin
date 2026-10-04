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
    phone: typeof body.phone === 'string' ? body.phone : undefined,
    contact: typeof body.contact === 'string' ? body.contact : undefined,
    pageUrl: typeof body.pageUrl === 'string' ? body.pageUrl : undefined,
    pagePath: typeof body.pagePath === 'string' ? body.pagePath : undefined,
    referrer: typeof body.referrer === 'string' ? body.referrer : undefined,
    locale: typeof body.locale === 'string' ? body.locale : undefined,
    utmSource: tracking(body, 'utmSource', 'utm_source'),
    utmMedium: tracking(body, 'utmMedium', 'utm_medium'),
    utmCampaign: tracking(body, 'utmCampaign', 'utm_campaign'),
    utmContent: tracking(body, 'utmContent', 'utm_content'),
    utmTerm: tracking(body, 'utmTerm', 'utm_term'),
    company: typeof body.company === 'string' ? body.company : undefined,
    service: typeof body.service === 'string' ? body.service : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    source: typeof body.source === 'string' ? body.source : undefined,
    // Optional attribution identifiers (snake_case like utm_*, camelCase accepted). Validated, never logged.
    attribution: {
      leadTrackingId: body.lead_tracking_id ?? body.leadTrackingId,
      metrikaClientId: body.metrika_client_id ?? body.metrikaClientId,
      yclid: body.yclid,
      firstSeenAt: body.first_seen_at ?? body.firstSeenAt,
    },
  })

  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  // A replayed lead_tracking_id returns the existing lead with the same 201 callers already expect
  // (DriveSet treats anything else as a failure); the header tells the two cases apart.
  return NextResponse.json(result.row, { status: 201, headers: result.replay ? { 'X-Idempotent-Replay': 'true' } : undefined })
}

// Accept both the data-layer names and the public OLNOO form's URL-style names.
function tracking(body: Record<string, unknown>, camel: string, snake: string): string | undefined {
  if (typeof body[camel] === 'string') return body[camel]
  return typeof body[snake] === 'string' ? body[snake] : undefined
}
