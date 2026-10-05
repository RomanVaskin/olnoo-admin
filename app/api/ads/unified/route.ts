import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { buildPeriod, readLeadSignalsForPeriod } from '@/lib/crm-observer'
import { resolveObserverPeriod } from '@/lib/observer-period'
import { buildUnifiedPayload, collectSources, resolveUnifiedProject, unifiedHttpStatus } from '@/lib/unified-analytics'
import { createDirectClient, directConfigFromEnv, DirectApiError, resolveCampaignId } from '@/lib/yandex-direct'
import { createMetrikaClient, metrikaConfigFromEnv, MetrikaApiError } from '@/lib/yandex-metrika'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/**
 * Unified Analytics v0.1 — READ-ONLY, aggregated: Direct + Metrika + CRM for one project and period (Ads Agent pipeline).
 * GET only. The three sources are read through their libraries (no internal HTTP calls) and run concurrently; one
 * failing source never fails the response (see `meta.sources`, `warnings`). The CRM is read through the narrow
 * `readLeadSignalsForPeriod` (no name/phone/contact/ids); the response never contains personal data, ClientID,
 * yclid or lead_tracking_id. No application-level auth (the app has none): in production admin.olnoo.com sits behind
 * an external access layer (see OLNOO_PROJECT_MAP.md, "Access to admin.olnoo.com").
 *
 * GET /api/ads/unified?project=<slug>&period=today|yesterday|last7
 * GET /api/ads/unified?project=<slug>&from=YYYY-MM-DD&to=YYYY-MM-DD   (Moscow calendar days)
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const projects = params.getAll('project')
  if (projects.length !== 1 || !SLUG_RE.test(projects[0])) {
    return NextResponse.json({ error: { kind: 'request', message: 'exactly one project slug is required' } }, { status: 400 })
  }
  const config = resolveUnifiedProject(projects[0])
  if (!config) return NextResponse.json({ error: { kind: 'unknown_project', message: 'project is not configured for unified analytics' } }, { status: 404 })

  const period = resolveObserverPeriod(params)
  if ('error' in period) return NextResponse.json({ error: { kind: 'request', message: period.error } }, { status: period.status })
  const crmPeriod = buildPeriod(period.from, period.to)
  if ('error' in crmPeriod) return NextResponse.json({ error: { kind: 'request', message: crmPeriod.error } }, { status: crmPeriod.status })

  const project = projects[0]
  const sources = await collectSources({
    direct: async () => {
      const cfg = directConfigFromEnv()
      if (!cfg) throw new DirectApiError('not_configured', 'Yandex Direct is not configured')
      const campaignId = resolveCampaignId(String(config.campaignId), cfg.campaignIds)
      return createDirectClient(cfg).observePeriod(campaignId, { from: period.from, to: period.to })
    },
    metrika: async () => {
      const cfg = metrikaConfigFromEnv()
      if (!cfg) throw new MetrikaApiError('not_configured', 'Yandex Metrika is not configured')
      const client = createMetrikaClient(cfg)
      const payload = await client.observe(project, period)
      // The extras are best-effort on top of the observer answer: a failure leaves them null (Metrika becomes `partial`).
      const extras = await client.observeUnifiedExtras(project, period, config.campaignId, config.testRules).catch(() => null)
      return { payload, extras }
    },
    crm: () => readLeadSignalsForPeriod(pool, { project: config.crmSlug, period: crmPeriod }),
  })

  // Journald: only which source failed and its error kind — never messages with data, tokens or lead rows.
  for (const [name, s] of Object.entries(sources)) if (s.status === 'unavailable') console.error(`[unified] ${name} unavailable kind=${s.error?.kind ?? '-'}`)

  const payload = buildUnifiedPayload({ project, config, period, now: new Date(), sources })
  return NextResponse.json(payload, { status: unifiedHttpStatus(sources) })
}
