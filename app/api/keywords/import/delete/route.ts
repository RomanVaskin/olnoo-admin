import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { deleteImport, previewImportDelete } from '@/lib/keywords-delete'
import { KeywordImportError } from '@/lib/keywords-import'

/**
 * «Удалить импорт». Body: { key: 'b:<batch id>' | 'l:<project id>|<timestamp>' (from the history), confirm }.
 * confirm=false is a read-only preview; confirm=true deletes only provably-created, unlinked
 * keywords in one transaction and marks the import 'Deleted'.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const key = typeof body?.key === 'string' ? body.key : ''
  if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 })
  try {
    return NextResponse.json(body.confirm === true ? await deleteImport(pool, key) : await previewImportDelete(pool, key))
  } catch (err) {
    if (err instanceof KeywordImportError) return NextResponse.json({ error: err.message }, { status: 400 })
    console.error('[wordstat-delete] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  }
}
