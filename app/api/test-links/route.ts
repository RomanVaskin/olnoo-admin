import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { createTestLink } from '@/lib/test-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }

/**
 * Generates a Test Link (Test Traffic v1): a plain URL with the test UTM, e.g.
 * https://driveset.ru/?utm_source=olnoo&utm_medium=test&utm_content=olnoo_test&utm_term=<sessionId>. The site's existing
 * first-touch attribution stores the UTM and the CRM classifies the resulting lead as TEST — no token, cookie or secret.
 * POST only, never cached. The only database access is one SELECT of the project's domain; nothing is stored or logged.
 * No application-level auth (the app has none): in production admin.olnoo.com sits behind an external access layer
 * (see OLNOO_PROJECT_MAP.md, "Access to admin.olnoo.com").
 *
 * POST /api/test-links  { "project": "driveset" }  →  { project, url, expiresAt: null, sessionId }
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
