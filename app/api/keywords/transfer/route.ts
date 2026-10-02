import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { KeywordImportError } from '@/lib/keywords-import'
import { previewKeywordTransfer, transferKeywords, type TransferRequest } from '@/lib/keywords-transfer'
import { readUploadedFiles } from '@/lib/wordstat-upload'

/**
 * Moves an import that went into the wrong project. Multipart fields: sourceProjectId,
 * targetProjectId, batchId (repeatable) and/or legacyKey (repeatable, `l:<project>|<ts>` from the
 * history), optional `file` fields (the original exports — required for legacy imports), and
 * confirm. confirm=false is read-only; confirm=true runs the transfer in one transaction.
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const confirm = form.get('confirm') === 'true'

  const { limitError, results, parsed } = await readUploadedFiles(form)
  if (limitError) return NextResponse.json({ error: limitError }, { status: 413 })
  const failed = results.find((file) => file.error)
  if (failed) return NextResponse.json({ error: `${failed.fileName}: ${failed.error}` }, { status: 400 })

  const request: TransferRequest = {
    sourceProjectId: String(form.get('sourceProjectId') ?? ''),
    targetProjectId: String(form.get('targetProjectId') ?? ''),
    scope: {
      batchIds: form.getAll('batchId').map(Number).filter(Number.isInteger),
      legacyKeys: form.getAll('legacyKey').map(String),
    },
    files: parsed,
  }

  try {
    const result = confirm ? await transferKeywords(pool, request) : await previewKeywordTransfer(pool, request)
    return NextResponse.json({ ...result, files: results.map(({ rows: _rows, ...file }) => file) })
  } catch (err) {
    if (err instanceof KeywordImportError) return NextResponse.json({ error: err.message }, { status: 400 })
    console.error('[wordstat-transfer] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Transfer failed' }, { status: 500 })
  }
}
