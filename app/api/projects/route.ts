import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export async function GET() {
  const { rows } = await pool.query(`
    SELECT
      pr.id,
      pr.client_id,
      pr.name,
      pr.domain,
      pr.sitemap_url,
      pr.status,
      pr.last_sync_at,
      pr.created_at,
      c.name AS client_name,
      COALESCE(pg_count.count, 0)::int AS pages_count,
      COALESCE(kw_count.count, 0)::int AS keywords_count
    FROM projects pr
    JOIN clients c ON c.id = pr.client_id
    LEFT JOIN (SELECT project_id, COUNT(*) AS count FROM pages GROUP BY project_id) pg_count
      ON pg_count.project_id = pr.id
    LEFT JOIN (SELECT project_id, COUNT(*) AS count FROM keywords GROUP BY project_id) kw_count
      ON kw_count.project_id = pr.id
    ORDER BY pr.created_at ASC, pr.id ASC
  `)
  return NextResponse.json(rows)
}
