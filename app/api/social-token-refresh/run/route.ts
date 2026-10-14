import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { refreshExpiringMetaTokens } from '@/lib/social-meta-token-refresh-sweep'

// Internal trigger only — not a client-facing API. Meant to be called once a day by a systemd
// timer on the same KZ server, via `curl` against 127.0.0.1 (see OLNOO_PROJECT_MAP.md's
// "Automatic Instagram/Threads token refresh" and deploy/social-token-refresh/). Reuses the exact
// same shared-secret-header pattern AND the same SOCIAL_SCHEDULER_TOKEN env var as
// app/api/social-scheduler/run/route.ts — this is a second, independent trigger (different table,
// different cadence, no shared lock with the publish sweep), not a second secret to provision; the
// trust boundary (this same server, localhost-only) is identical.
export async function POST(req: Request) {
  const token = process.env.SOCIAL_SCHEDULER_TOKEN
  if (!token) {
    return NextResponse.json({ error: 'SOCIAL_SCHEDULER_TOKEN is not configured on the server' }, { status: 500 })
  }
  if (req.headers.get('x-scheduler-token') !== token) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const results = await refreshExpiringMetaTokens(pool)
    const refreshed = results.filter((r) => r.outcome === 'refreshed').length
    const errored = results.filter((r) => r.outcome === 'error').length
    const racedSkips = results.filter((r) => r.outcome === 'skipped_raced').length
    console.log(
      `social-token-refresh: checked ${results.length} expiring-soon account(s) — refreshed ${refreshed}, errored ${errored}, raced ${racedSkips}`,
      JSON.stringify(results),
    )
    return NextResponse.json({ checked: results.length, refreshed, errored, racedSkips, results })
  } catch (err) {
    console.error('social-token-refresh/run failed', err)
    return NextResponse.json({ error: 'token refresh sweep failed' }, { status: 500 })
  }
}
