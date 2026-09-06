import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { parseImportFile } from '@/lib/import-parse'

const PREVIEW_LIMIT = 20

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')

  const { rows } = await pool.query(
    `
    SELECT i.id, i.file_name, i.rows_count, i.status, i.created_at, p.name AS project_name
    FROM imports i
    JOIN projects p ON p.id = i.project_id
    WHERE ($1::int IS NULL OR i.project_id = $1::int)
    ORDER BY i.created_at DESC
    LIMIT 20
    `,
    [projectId],
  )
  return NextResponse.json(rows)
}

export async function POST(req: Request) {
  const form = await req.formData()
  const projectId = form.get('projectId')
  const confirm = form.get('confirm') === 'true'
  const file = form.get('file')

  if (!projectId || !(file instanceof File)) {
    return NextResponse.json({ error: 'projectId and file are required' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  let rows
  try {
    rows = await parseImportFile(buffer, file.name)
  } catch {
    return NextResponse.json({ error: 'Could not parse file' }, { status: 400 })
  }

  if (!confirm) {
    return NextResponse.json({ preview: rows.slice(0, PREVIEW_LIMIT), total: rows.length })
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No valid rows found in file' }, { status: 400 })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const row of rows) {
      await client.query(
        `
        INSERT INTO keywords (project_id, query, frequency, region, status)
        VALUES ($1, $2, $3, $4, 'active')
        ON CONFLICT (project_id, query, region)
        DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = now()
        `,
        [projectId, row.keyword, row.frequency, row.region],
      )
    }
    await client.query(
      `INSERT INTO imports (project_id, file_name, rows_count, status) VALUES ($1, $2, $3, 'Imported')`,
      [projectId, file.name, rows.length],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    return NextResponse.json({ error: 'Import failed' }, { status: 500 })
  } finally {
    client.release()
  }

  return NextResponse.json({ imported: rows.length })
}
