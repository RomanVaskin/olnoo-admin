import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getProject } from '@/lib/projects-registry'
import { linkAfterSnapshots } from '@/lib/seo-page-changes'
import { getLatestSeoSnapshots, observerPeriod, runSeoObserver } from '@/lib/seo-observer'
import { createMetrikaClient, metrikaConfigFromEnv } from '@/lib/yandex-metrika'
import { createWebmasterClient, webmasterConfigFromEnv } from '@/lib/yandex-webmaster'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * SEO Observer v1 — read-only observer of one project's search performance (Yandex Webmaster queries + Metrika organic landing pages).
 *  GET  /api/seo-observer?projectId=<id>   → the latest SAVED snapshots only (database; no external API call, ever)
 *  POST /api/seo-observer { projectId }    → MANUAL run: fetch both providers, save each successful one, return the run state
 * Unknown or archived project → 404. Tokens are server env only and never appear in a response, a snapshot or a log.
 */
async function activeProject(raw: unknown) {
  const id = Number(raw)
  if (!Number.isInteger(id) || id < 1) return null
  const p = await getProject(pool, id)
  return p && !p.archived_at ? p : null
}

export async function GET(req: Request) {
  const project = await activeProject(new URL(req.url).searchParams.get('projectId'))
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  const period = observerPeriod()
  return NextResponse.json({ projectId: project.id, dateFrom: period.from, dateTo: period.to, snapshots: await getLatestSeoSnapshots(pool, project.id) })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const project = await activeProject((body as { projectId?: unknown } | null)?.projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const webmasterConfig = webmasterConfigFromEnv()
  const metrikaConfig = metrikaConfigFromEnv()
  const run = await runSeoObserver(
    pool,
    { id: project.id, slug: project.slug, domain: project.domain },
    {
      webmaster: webmasterConfig ? createWebmasterClient(webmasterConfig) : null,
      metrika: metrikaConfig ? createMetrikaClient(metrikaConfig) : null,
    },
  )
  // Journald: only the status and the error kind of each source — never a message with data, a token or rows.
  for (const [name, s] of [['webmaster', run.webmaster], ['metrika', run.metrika]] as const) {
    if (s.status === 'error') console.error(`[seo-observer] ${name} error kind=${s.kind}`)
  }
  // Before/after: a fresh snapshot may close open changes of this project. Never fails the run (the snapshots are already saved).
  if (run.webmaster.status === 'ok' || run.metrika.status === 'ok') {
    try { await linkAfterSnapshots(pool, project.id) } catch { console.error('[seo-observer] linking after-snapshots failed') }
  }
  return NextResponse.json({ ...run, snapshots: await getLatestSeoSnapshots(pool, project.id) })
}
