import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')

  const { rows } = await pool.query(
    `
    SELECT
      pg.id,
      pg.project_id,
      pg.url,
      pg.title,
      pg.h1,
      pg.description,
      pg.locale,
      pg.status,
      pg.last_seen_at,
      kw.query AS target_keyword
    FROM pages pg
    LEFT JOIN LATERAL (
      SELECT k.query
      FROM keyword_pages kp
      JOIN keywords k ON k.id = kp.keyword_id
      WHERE kp.page_id = pg.id AND kp.is_primary = true
      ORDER BY kp.created_at ASC
      LIMIT 1
    ) kw ON true
    WHERE ($1::int IS NULL OR pg.project_id = $1::int)
    ORDER BY pg.url ASC
    `,
    [projectId],
  )
  return NextResponse.json(rows)
}
