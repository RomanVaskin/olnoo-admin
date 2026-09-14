import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { runSocialScheduler } from '@/lib/social-scheduler'

// Internal trigger only — not a client-facing API. Meant to be called once a minute by a systemd
// timer on the same KZ server, via `curl` against 127.0.0.1 (see OLNOO_PROJECT_MAP.md, "Social
// scheduler"). This app has no auth layer at all yet (see OLNOO_PROJECT_MAP.md's "OLNOO Admin"
// section — every route is currently reachable by anyone who can reach the domain), so this route
// protects itself the same way the existing server-to-server intake (/api/leads/inbound) does: a
// shared-secret header checked against a server-only env var, rather than trusting any
// proxy-supplied "this came from localhost" header nginx wasn't specifically configured to
// guarantee. SOCIAL_SCHEDULER_TOKEN must be set in production for this route to do anything —
// unset is a hard refusal, not an open door.
export async function POST(req: Request) {
  const token = process.env.SOCIAL_SCHEDULER_TOKEN
  if (!token) {
    return NextResponse.json({ error: 'SOCIAL_SCHEDULER_TOKEN is not configured on the server' }, { status: 500 })
  }
  if (req.headers.get('x-scheduler-token') !== token) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await runSocialScheduler(pool)
    if (result.skipped) {
      console.log(`social-scheduler: skipped (${result.reason})`)
      return NextResponse.json({ skipped: true, reason: result.reason })
    }
    console.log(
      `social-scheduler: processed ${result.processed.length} due post(s)`,
      JSON.stringify(
        result.processed.map((p) => ({
          postId: p.postId,
          project: p.projectSlug,
          error: p.error,
          outcomes: p.outcomes.map((o) => `${o.platform}:${o.outcome}`),
        })),
      ),
    )
    return NextResponse.json({ skipped: false, processedCount: result.processed.length, processed: result.processed })
  } catch (err) {
    console.error('social-scheduler/run failed', err)
    return NextResponse.json({ error: 'scheduler run failed' }, { status: 500 })
  }
}
