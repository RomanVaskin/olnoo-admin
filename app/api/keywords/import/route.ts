import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { ImportParseError, parseImportFile } from '@/lib/import-parse'
import { importKeywordFiles, isSupportedImportFile, mergeImportRows, type ImportFileRows } from '@/lib/keywords-import'

const PREVIEW_LIMIT = 20
const MAX_FILES = 30

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

/**
 * One or more `file` fields (CSV/XLSX Wordstat exports). confirm=false returns per-file parse
 * results plus a preview of the merged, de-duplicated keywords; confirm=true imports them all in
 * one transaction (any unreadable file rejects the whole request — the UI only sends valid ones).
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const projectId = form.get('projectId')
  const confirm = form.get('confirm') === 'true'
  const uploads = form.getAll('file').filter((value): value is File => value instanceof File)

  if (!projectId || uploads.length === 0) {
    return NextResponse.json({ error: 'projectId and file are required' }, { status: 400 })
  }
  if (uploads.length > MAX_FILES) {
    return NextResponse.json({ error: `Не больше ${MAX_FILES} файлов за один импорт` }, { status: 400 })
  }

  const parsed: ImportFileRows[] = []
  const files: { fileName: string; total: number; error?: string }[] = []
  for (const upload of uploads) {
    if (!isSupportedImportFile(upload.name)) {
      files.push({ fileName: upload.name, total: 0, error: 'Поддерживаются только файлы .csv и .xlsx' })
      continue
    }
    try {
      const rows = await parseImportFile(Buffer.from(await upload.arrayBuffer()), upload.name)
      parsed.push({ fileName: upload.name, rows })
      files.push({ fileName: upload.name, total: rows.length })
    } catch (err) {
      const reason = err instanceof ImportParseError ? err.message : 'неизвестная ошибка при разборе файла'
      files.push({ fileName: upload.name, total: 0, error: `Не удалось прочитать файл: ${reason}` })
    }
  }

  const merged = mergeImportRows(parsed.flatMap((file) => file.rows))
  const failed = files.find((file) => file.error)

  if (!confirm) {
    // `error` keeps the single-file response shape for a lone unreadable file.
    const status = failed && parsed.length === 0 ? 400 : 200
    return NextResponse.json(
      { files, preview: merged.slice(0, PREVIEW_LIMIT), total: merged.length, ...(status === 400 ? { error: failed!.error } : {}) },
      { status },
    )
  }

  if (failed) {
    return NextResponse.json({ error: `${failed.fileName}: ${failed.error}`, files }, { status: 400 })
  }
  if (merged.length === 0) {
    return NextResponse.json({ error: 'No valid rows found in file' }, { status: 400 })
  }

  try {
    const result = await importKeywordFiles(pool, projectId as string, parsed)
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Import failed' }, { status: 500 })
  }
}
