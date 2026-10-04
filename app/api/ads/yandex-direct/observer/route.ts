import { NextResponse } from 'next/server'
import {
  createDirectClient,
  directConfigFromEnv,
  directErrorHttpStatus,
  DirectApiError,
  resolveCampaignId,
} from '@/lib/yandex-direct'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_DAYS = 7
const MAX_DAYS = 30

/**
 * READ-ONLY Yandex Direct observer (Ads Agent MVP): campaign + daily stats + search queries for the
 * allow-listed campaign(s) in YANDEX_DIRECT_CAMPAIGN_IDS. Never writes to Direct, never returns the
 * OAuth token. No application-level auth here (the app has none): in production admin.olnoo.com is
 * protected by an external layer in front of Next.js (see OLNOO_PROJECT_MAP.md, "Access to admin.olnoo.com").
 *
 * GET /api/ads/yandex-direct/observer[?days=7][&campaignId=<allow-listed id>][&structure=1]
 *
 * `structure=1` adds ad groups, keywords (with bids) and negative keywords of that campaign (read-only; the
 * Direct methods are fixed in the client — nothing here can select a method or another campaign).
 */
export async function GET(req: Request) {
  const config = directConfigFromEnv()
  if (!config) {
    return NextResponse.json({ error: { kind: 'not_configured', message: 'Yandex Direct is not configured' } }, { status: 503 })
  }

  const { searchParams } = new URL(req.url)
  const daysParam = searchParams.get('days')
  const days = daysParam === null ? DEFAULT_DAYS : Number(daysParam)
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return NextResponse.json({ error: { kind: 'request', message: `days must be an integer from 1 to ${MAX_DAYS}` } }, { status: 400 })
  }

  const structureParam = searchParams.get('structure')
  if (structureParam !== null && structureParam !== '1' && structureParam !== 'true') {
    return NextResponse.json({ error: { kind: 'request', message: 'structure must be 1 or true' } }, { status: 400 })
  }

  try {
    const campaignId = resolveCampaignId(searchParams.get('campaignId'), config.campaignIds)
    const payload = await createDirectClient(config).observe(campaignId, days, { structure: structureParam !== null })
    return NextResponse.json(payload)
  } catch (error) {
    if (error instanceof DirectApiError) {
      // Only the kind, Direct's code and RequestId are logged/returned — never the token or raw bodies.
      console.error(`[yandex-direct] ${error.kind} code=${error.directCode ?? '-'} requestId=${error.requestId ?? '-'}`)
      return NextResponse.json(
        { error: { kind: error.kind, message: error.message, directCode: error.directCode, requestId: error.requestId } },
        { status: directErrorHttpStatus(error.kind) },
      )
    }
    console.error('[yandex-direct] unexpected failure')
    return NextResponse.json({ error: { kind: 'internal', message: 'unexpected failure' } }, { status: 500 })
  }
}
