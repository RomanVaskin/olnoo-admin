import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { CLIENTS_WITH_PROJECT_COUNT_SQL } from '@/lib/projects-registry'

export async function GET() {
  const { rows } = await pool.query(CLIENTS_WITH_PROJECT_COUNT_SQL)
  return NextResponse.json(rows)
}
