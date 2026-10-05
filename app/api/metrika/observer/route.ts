import { NextResponse } from 'next/server'
import { resolveObserverPeriod } from '@/lib/observer-period'
import {
  createMetrikaClient,
  metrikaConfigFromEnv,
  metrikaErrorHttpStatus,
  MetrikaApiError,
  resolveMetrikaProject,
} from '@/lib/yandex-metrika'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/**
 * READ-ONLY Metrika Observer v0.1 (Ads Agent pipeline: Direct Observer → CRM Observer → Metrika Observer → unified
 * analytics). GET only; aggregated numbers only — no ClientID, yclid or user data is requested or returned. The token
 * (`YANDEX_METRIKA_TOKEN`) is never returned or logged. No application-level auth (the app has none): in production
 * admin.olnoo.com sits behind an external access layer (see OLNOO_PROJECT_MAP.md, "Access to admin.olnoo.com").
 *
 * GET /api/metrika/observer?project=<slug>&period=today|yesterday|last7
 * GET /api/metrika/observer?project=<slug>&from=YYYY-MM-DD&to=YYYY-MM-DD   (Moscow calendar days)
 */
export async function GET(req: Request) {
  const config = metrikaConfigFromEnv()
  if (!config) {
    return NextResponse.json({ error: { kind: 'not_configured', message: 'Yandex Metrika is not configured' } }, { status: 503 })
  }

  const params = new URL(req.url).searchParams
  const projects = params.getAll('project')
  if (projects.length !== 1 || !SLUG_RE.test(projects[0])) {
    return NextResponse.json({ error: { kind: 'request', message: 'exactly one project slug is required' } }, { status: 400 })
  }
  const period = resolveObserverPeriod(params)
  if ('error' in period) return NextResponse.json({ error: { kind: 'request', message: period.error } }, { status: period.status })

  try {
    resolveMetrikaProject(projects[0])
    return NextResponse.json(await createMetrikaClient(config).observe(projects[0], period))
  } catch (error) {
    if (error instanceof MetrikaApiError) {
      // Only the kind, Metrika's error type and a redacted message are logged/returned — never the token or raw bodies.
      console.error(`[yandex-metrika] ${error.kind} code=${error.metrikaCode ?? '-'}`)
      return NextResponse.json(
        { error: { kind: error.kind, message: error.message, metrikaCode: error.metrikaCode } },
        { status: metrikaErrorHttpStatus(error.kind) },
      )
    }
    console.error('[yandex-metrika] unexpected failure')
    return NextResponse.json({ error: { kind: 'internal', message: 'unexpected failure' } }, { status: 500 })
  }
}
