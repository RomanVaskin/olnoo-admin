import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { importKeywordFiles, KeywordImportError, listImportHistory } from '@/lib/keywords-import'
import { mergeImportRows } from '@/lib/wordstat-import-rules'
import { readUploadedFiles } from '@/lib/wordstat-upload'

const PREVIEW_LIMIT = 20
const HISTORY_PAGE = 10

/** Import history grouped by batch (legacy imports by transaction), paginated; `includeDeleted=1` adds deleted imports. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectId = Number(searchParams.get('projectId')) || null
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)
  const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit')) || HISTORY_PAGE))
  // Deleted imports stay in the DB (history is kept) but are hidden unless asked for.
  const includeDeleted = searchParams.get('includeDeleted') === '1'
  return NextResponse.json(await listImportHistory(pool, { limit, offset, projectId, includeDeleted }))
}

/**
 * One or more `file` fields (CSV/XLSX Wordstat exports, max 30 files / 10 MB per request).
 * confirm=false: per-file parse results (with their rows, so the UI can count unique keywords
 * across files) and a preview of the merged keywords. confirm=true: imports all files as ONE
 * batch in one transaction; any unreadable file rejects the request (the UI sends only valid ones).
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const projectId = form.get('projectId')
  const confirm = form.get('confirm') === 'true'
  if (!projectId || !form.getAll('file').length) {
    return NextResponse.json({ error: 'projectId and file are required' }, { status: 400 })
  }

  const { limitError, results, parsed } = await readUploadedFiles(form)
  if (limitError) return NextResponse.json({ error: limitError }, { status: 413 })

  const merged = mergeImportRows(parsed.flatMap((file) => file.rows))
  const failed = results.find((file) => file.error)

  if (!confirm) {
    // `error` keeps the single-file response shape for a lone unreadable file.
    const status = failed && parsed.length === 0 ? 400 : 200
    return NextResponse.json(
      { files: results, preview: merged.slice(0, PREVIEW_LIMIT), total: merged.length, ...(status === 400 ? { error: failed!.error } : {}) },
      { status },
    )
  }

  if (failed) {
    return NextResponse.json({ error: `${failed.fileName}: ${failed.error}` }, { status: 400 })
  }
  if (merged.length === 0) {
    return NextResponse.json({ error: 'No valid rows found in file' }, { status: 400 })
  }

  try {
    return NextResponse.json(await importKeywordFiles(pool, projectId as string, parsed))
  } catch (err) {
    if (err instanceof KeywordImportError) return NextResponse.json({ error: err.message }, { status: 400 })
    console.error('[wordstat-import] import failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Import failed' }, { status: 500 })
  }
}
