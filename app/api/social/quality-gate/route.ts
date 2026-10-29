import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { runQualityGate, QualityGateError } from '@/lib/social-quality-gate'
import { AiRouterError } from '@/lib/ai-router'

// OLNOO Social AI Agent 2.0 — Quality Gate. Reviews one post's text against a fixed set of
// criteria; never writes to social_posts itself (see lib/social-quality-gate.ts's own comment) —
// a "Suggest a fix" action in the existing post card reuses the existing AI Editor's `custom`
// action and its own compare/Apply/Cancel mechanism, unchanged.
export async function POST(req: Request) {
  const payload = await req.json().catch(() => null)
  if (!payload || typeof payload.project !== 'string') {
    return NextResponse.json({ error: 'project is required' }, { status: 400 })
  }
  const projectId = await resolveProjectId(payload.project)
  if (!projectId) {
    return NextResponse.json({ error: 'a known project is required' }, { status: 400 })
  }

  const text = typeof payload.text === 'string' ? payload.text : ''
  const channels = Array.isArray(payload.channels) ? payload.channels.filter((c: unknown): c is string => typeof c === 'string') : []

  try {
    const result = await runQualityGate(pool, projectId, { text, channels })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof QualityGateError || err instanceof AiRouterError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    // Never surface a raw error (e.g. a Postgres error message) to the client — same posture as
    // app/api/social/ai-edit/route.ts's own catch-all.
    console.error('social/quality-gate failed', err)
    return NextResponse.json({ error: 'Could not run the Quality Gate. Please try again.' }, { status: 500 })
  }
}
