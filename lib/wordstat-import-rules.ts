// Dependency-free rules shared by the Wordstat import UI and API (and unit-testable with
// node --test): what a batch may contain and how rows from several files are merged.

export type KeywordRow = { keyword: string; frequency: number; region: string }

/** One import (or transfer) request: at most this many files ... */
export const MAX_IMPORT_FILES = 30
/** ... each at most this big (a real Wordstat XLSX/CSV is tens of KB) ... */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024
/** ... and together at most this big — one multipart request. */
export const MAX_IMPORT_TOTAL_BYTES = 10 * 1024 * 1024

/** Only these two formats are parsed; anything else (e.g. a dropped PDF) is rejected before parsing. */
export function isSupportedImportFile(fileName: string): boolean {
  return /\.(csv|xlsx)$/i.test(fileName)
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Checks a selection before it is sent. Returns a user-facing reason, or null when it fits.
 * Example: «31 файл · 18.4 MB. Максимум 30 файлов и 10.0 MB за один импорт».
 */
export function importSelectionError(files: { name: string; size: number }[]): string | null {
  const total = files.reduce((sum, f) => sum + f.size, 0)
  const tooBig = files.find((f) => f.size > MAX_IMPORT_FILE_BYTES)
  if (files.length > MAX_IMPORT_FILES || total > MAX_IMPORT_TOTAL_BYTES) {
    return `${filesLabel(files.length)} · ${formatMegabytes(total)}. Максимум ${MAX_IMPORT_FILES} файлов и ${formatMegabytes(MAX_IMPORT_TOTAL_BYTES)} за один импорт — разделите выбор.`
  }
  if (tooBig) {
    return `${tooBig.name}: ${formatMegabytes(tooBig.size)}. Максимум ${formatMegabytes(MAX_IMPORT_FILE_BYTES)} на файл.`
  }
  return null
}

/** Unique key of a keyword inside one project — the DB's UNIQUE (project_id, query, region). */
export function keywordKey(row: { keyword: string; region: string }): string {
  return `${row.keyword}\u0000${row.region}`
}

/**
 * Merges rows from one or more Wordstat exports into one list unique by (query, region) — the
 * same keyword in two exports is one keyword. When the exports disagree on frequency the highest
 * wins, so the result does not depend on file order.
 */
export function mergeImportRows<T extends KeywordRow>(rows: T[]): KeywordRow[] {
  const merged = new Map<string, KeywordRow>()
  for (const row of rows) {
    const key = keywordKey(row)
    const existing = merged.get(key)
    if (!existing) merged.set(key, { keyword: row.keyword, frequency: row.frequency, region: row.region })
    else if (row.frequency > existing.frequency) existing.frequency = row.frequency
  }
  return [...merged.values()]
}

function filesLabel(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} файл`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} файла`
  return `${n} файлов`
}
