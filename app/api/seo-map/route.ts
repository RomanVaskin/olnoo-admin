import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')

  const { rows } = await pool.query(
    `
    SELECT
      k.id AS keyword_id,
      k.query,
      k.frequency,
      k.cluster,
      pg.id AS page_id,
      pg.url AS page_url
    FROM keywords k
    LEFT JOIN LATERAL (
      SELECT p.id, p.url
      FROM keyword_pages kp
      JOIN pages p ON p.id = kp.page_id
      WHERE kp.keyword_id = k.id AND kp.is_primary = true
      ORDER BY kp.created_at ASC
      LIMIT 1
    ) pg ON true
    WHERE ($1::int IS NULL OR k.project_id = $1::int)
    ORDER BY k.cluster NULLS LAST, k.frequency DESC NULLS LAST, k.query ASC
    `,
    [projectId],
  )

  const items = rows.map((r) => ({
    keywordId: r.keyword_id,
    query: r.query,
    frequency: r.frequency,
    cluster: r.cluster,
    pageId: r.page_id,
    pageUrl: r.page_url,
    status: r.page_id ? 'Mapped' : 'Unassigned',
  }))

  return NextResponse.json(items)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const keywordId = body?.keywordId
  const pageId = body?.pageId ?? null

  if (!keywordId) {
    return NextResponse.json({ error: 'keywordId is required' }, { status: 400 })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM keyword_pages WHERE keyword_id = $1', [keywordId])
    if (pageId) {
      await client.query(
        'INSERT INTO keyword_pages (keyword_id, page_id, is_primary) VALUES ($1, $2, true)',
        [keywordId, pageId],
      )
    }
    await client.query('COMMIT')
  } catch {
    await client.query('ROLLBACK')
    return NextResponse.json({ error: 'Failed to update mapping' }, { status: 500 })
  } finally {
    client.release()
  }

  return NextResponse.json({ ok: true })
}
