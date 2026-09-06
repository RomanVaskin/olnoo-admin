import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')

  const { rows } = await pool.query(
    `
    SELECT
      k.id,
      k.project_id,
      k.query,
      k.frequency,
      k.region,
      k.cluster,
      k.status,
      pg.id AS target_page_id,
      pg.url AS target_page_url
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
    ORDER BY k.frequency DESC NULLS LAST, k.query ASC
    `,
    [projectId],
  )
  return NextResponse.json(rows)
}
