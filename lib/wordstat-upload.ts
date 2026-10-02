import { ImportParseError, parseImportFile } from '@/lib/import-parse'
import type { ImportFileRows } from '@/lib/keywords-import'
import {
  importSelectionError,
  isSupportedImportFile,
  type KeywordRow,
} from '@/lib/wordstat-import-rules'

export type UploadedFileResult = { fileName: string; size: number; total: number; error?: string; rows?: KeywordRow[] }

/**
 * Reads the `file` fields of an import/transfer request: enforces the batch limits (count, per
 * file and total size — the same rule the UI applies before sending), rejects non-.csv/.xlsx and
 * parses each file. Returns per-file results in upload order plus the successfully parsed files.
 */
export async function readUploadedFiles(
  form: FormData,
): Promise<{ limitError: string | null; results: UploadedFileResult[]; parsed: ImportFileRows[] }> {
  const uploads = form.getAll('file').filter((value): value is File => value instanceof File)
  const limitError = importSelectionError(uploads.map((f) => ({ name: f.name, size: f.size })))
  if (limitError) return { limitError, results: [], parsed: [] }

  const results: UploadedFileResult[] = []
  const parsed: ImportFileRows[] = []
  for (const upload of uploads) {
    if (!isSupportedImportFile(upload.name)) {
      results.push({ fileName: upload.name, size: upload.size, total: 0, error: 'Поддерживаются только файлы .csv и .xlsx' })
      continue
    }
    try {
      const rows = await parseImportFile(Buffer.from(await upload.arrayBuffer()), upload.name)
      parsed.push({ fileName: upload.name, rows })
      results.push({ fileName: upload.name, size: upload.size, total: rows.length, rows })
    } catch (err) {
      const reason = err instanceof ImportParseError ? err.message : 'неизвестная ошибка при разборе файла'
      results.push({ fileName: upload.name, size: upload.size, total: 0, error: `Не удалось прочитать файл: ${reason}` })
    }
  }
  return { limitError: null, results, parsed }
}
