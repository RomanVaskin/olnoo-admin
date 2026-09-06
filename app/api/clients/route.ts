import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export async function GET() {
  const { rows } = await pool.query(`
    SELECT
      c.id,
      c.name,
      c.contact,
      c.status,
      c.created_at,
      COUNT(p.id)::int AS project_count
    FROM clients c
    LEFT JOIN projects p ON p.client_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at ASC, c.id ASC
  `)
  return NextResponse.json(rows)
}
