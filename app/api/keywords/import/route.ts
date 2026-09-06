import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { ImportParseError, parseImportFile } from '@/lib/import-parse'
import { importKeywordRows } from '@/lib/keywords-import'

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
  } catch (err) {
    const reason = err instanceof ImportParseError ? err.message : 'неизвестная ошибка при разборе файла'
    return NextResponse.json({ error: `Не удалось прочитать файл: ${reason}` }, { status: 400 })
  }

  if (!confirm) {
    return NextResponse.json({ preview: rows.slice(0, PREVIEW_LIMIT), total: rows.length })
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No valid rows found in file' }, { status: 400 })
  }

  try {
    const result = await importKeywordRows(pool, projectId as string, file.name, rows)
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Import failed' }, { status: 500 })
  }
}
