import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { getSource } from '@/lib/content-factory-sources'
import { checkSourceNow } from '@/lib/content-factory-check'

/** "Проверить сейчас" — fetches the source's adapter once and stores any genuinely new items.
 * Never throws an unhandled error for an adapter failure (checkSourceNow itself always records
 * the outcome on the source row and returns `{created: [], error}` rather than throwing) — this
 * route's own try/catch only guards against something unrelated going wrong (e.g. a DB error). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = new URL(req.url).searchParams.get('project')
  const projectId = await resolveProjectId(project)
  if (!projectId) return NextResponse.json({ error: 'a known project is required' }, { status: 400 })

  const source = await getSource(pool, projectId, id)
  if (!source) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    const result = await checkSourceNow(pool, source)
    return NextResponse.json({ createdCount: result.created.length, created: result.created, error: result.error })
  } catch (err) {
    console.error('content-factory/sources check failed', err)
    return NextResponse.json({ error: 'Could not check this source. Please try again.' }, { status: 500 })
  }
}
