import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { createTestLink } from '@/lib/test-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }

/**
 * Generates a signed, short-lived, project-bound Test Link (Test Traffic v1, PR B). POST only (no GET generator),
 * never cached. The only database access is one SELECT of the project's domain: no token, session id or audit row is
 * stored. Nothing here logs the body, the URL, the token or a secret. No application-level auth (the app has none): in
 * production admin.olnoo.com sits behind an external access layer (see OLNOO_PROJECT_MAP.md, "Access to admin.olnoo.com").
 * The client-site route that accepts the link ships separately; this endpoint only issues it.
 *
 * POST /api/test-links  { "project": "driveset", "ttlMinutes"?: 120 }  →  { project, url, expiresAt, sessionId }
 */
export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null)
  try {
    const result = await createTestLink({
      body,
      loadDomain: async (slug) => (await pool.query<{ domain: string }>('SELECT domain FROM projects WHERE slug = $1', [slug])).rows[0]?.domain ?? null,
    })
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE })
  } catch {
    // No detail is logged or returned: the request/response may contain a link.
    return NextResponse.json({ error: { kind: 'internal', message: 'unexpected failure' } }, { status: 500, headers: NO_STORE })
  }
}
