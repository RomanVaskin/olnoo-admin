import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { runContentFactorySourceSweep } from '@/lib/content-factory-scheduler'

// Internal trigger only — not a client-facing API. Meant to be called periodically (e.g. once
// every few minutes by a systemd timer) on the same server, same posture as
// app/api/social-scheduler/run/route.ts: this app has no auth layer at all yet, so this route
// protects itself with a shared-secret header checked against a server-only env var.
// CONTENT_FACTORY_SCHEDULER_TOKEN must be set in production for this route to do anything — unset
// is a hard refusal, not an open door. See lib/content-factory-scheduler.ts's own comment for
// exactly what this sweep does (source checking only) and does not yet do (no automatic
// generation or publishing).
export async function POST(req: Request) {
  const token = process.env.CONTENT_FACTORY_SCHEDULER_TOKEN
  if (!token) {
    return NextResponse.json({ error: 'CONTENT_FACTORY_SCHEDULER_TOKEN is not configured on the server' }, { status: 500 })
  }
  if (req.headers.get('x-scheduler-token') !== token) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const results = await runContentFactorySourceSweep(pool)
    const createdTotal = results.reduce((sum, r) => sum + r.createdCount, 0)
    console.log(`content-factory-scheduler: checked ${results.length} source(s), ${createdTotal} new item(s)`)
    return NextResponse.json({ checkedCount: results.length, createdTotal, results })
  } catch (err) {
    console.error('content-factory-scheduler/run failed', err)
    return NextResponse.json({ error: 'scheduler run failed' }, { status: 500 })
  }
}
