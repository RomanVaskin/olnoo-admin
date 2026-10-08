import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { getProject } from '@/lib/projects-registry'
import { readLastResult } from '@/lib/seo-health-store'
import { getExecutorRun, startExecutorRun } from '@/lib/seo-executor'
import { recordFixChanges } from '@/lib/seo-page-changes'
import { realExecutorDeps } from '@/lib/seo-executor-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const deps = () => realExecutorDeps({ getProject: (id) => getProject(pool, id), readLastResult: (id) => readLastResult(pool, id), recordChange: async (info) => { await recordFixChanges(pool, info) } })

/**
 * SEO Executor v1 (human-started, safe Technical SEO codes only; see lib/seo-executor.ts).
 * POST { projectId, issues?: [{ code, url? }] } → 202 { run } (the pipeline continues in the background); 409 when a run is already active for the project.
 * The server re-reads the project and the saved Technical SEO result itself — issue details from the browser are never trusted.
 * GET ?projectId= → { run } (current / last in-memory run, or null). Never merges anything.
 */
export async function POST(req: Request) {
  let body: { projectId?: unknown; issues?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    const res = await startExecutorRun(deps(), { projectId: body.projectId, issues: body.issues })
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.http })
    return NextResponse.json({ runId: res.run.runId, run: res.run }, { status: 202 })
  } catch (err) {
    console.error('seo-executor start failure', err)
    return NextResponse.json({ error: 'Executor could not be started' }, { status: 500 })
  }
}

export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get('projectId'))
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  return NextResponse.json({ run: getExecutorRun(id) })
}
