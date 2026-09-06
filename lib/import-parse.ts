import ExcelJS from 'exceljs'
import iconv from 'iconv-lite'
import { parse } from 'csv-parse/sync'

export type ImportRow = {
  keyword: string
  frequency: number
  region: string
}

/** Thrown for any recognized, user-facing reason a file could not be parsed. */
export class ImportParseError extends Error {}

const KEYWORD_ALIASES = [
  'keyword',
  'query',
  'phrase',
  'ключевое слово',
  'ключевой запрос',
  'фраза',
  'запрос',
  'запросы',
  'запросы со словами',
]

const FREQUENCY_ALIASES = [
  'frequency',
  'freq',
  'count',
  'частота',
  'частотность',
  'показы',
  'число запросов',
  'число показов',
  'число показов в месяц',
  'показов в месяц',
]

const REGION_ALIASES = ['region', 'регион']

const HEADER_ALIASES: Record<string, keyof ImportRow> = {}
for (const key of KEYWORD_ALIASES) HEADER_ALIASES[key] = 'keyword'
for (const key of FREQUENCY_ALIASES) HEADER_ALIASES[key] = 'frequency'
for (const key of REGION_ALIASES) HEADER_ALIASES[key] = 'region'

/** Normalizes a raw header cell so RU/EN column-name variants and stray punctuation/whitespace all map alike. */
function normalizeHeaderKey(key: string): string {
  return key
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^"+|"+$/g, '')
    .replace(/[":]+$/g, '')
    .trim()
}

function normalizeRow(raw: Record<string, unknown>): ImportRow | null {
  const row: Partial<ImportRow> = {}

  for (const [rawKey, value] of Object.entries(raw)) {
    const field = HEADER_ALIASES[normalizeHeaderKey(rawKey)]
    if (!field) continue

    if (field === 'frequency') {
      const numeric =
        typeof value === 'number' ? value : parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10)
      row.frequency = Number.isFinite(numeric) ? numeric : 0
    } else {
      const str = String(value ?? '').trim()
      if (str) row[field] = str
    }
  }

  if (!row.keyword) return null
  return { keyword: row.keyword, frequency: row.frequency ?? 0, region: row.region ?? '' }
}

async function parseXlsx(buffer: Buffer): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) return []

  const headerRow = sheet.getRow(1)
  const headers: string[] = []
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? '')
  })

  const rows: Record<string, unknown>[] = []
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const entry: Record<string, unknown> = {}
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber]
      if (header) entry[header] = cell.value
    })
    rows.push(entry)
  })

  return rows
}

/**
 * Decodes a raw upload into text, handling the encodings/BOMs seen in the wild:
 * UTF-8 (with or without BOM), UTF-16LE/BE (Excel "Unicode Text" exports), and
 * Windows-1251 — the encoding Yandex Wordstat's native CSV export actually uses,
 * which reads as garbled/invalid text (and can desync column counts) under UTF-8.
 */
function decodeBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return iconv.decode(buffer.subarray(2), 'utf16-le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return iconv.decode(buffer.subarray(2), 'utf16-be')
  }

  let bytes = buffer
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3)
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return iconv.decode(bytes, 'win1251')
  }
}

const DELIMITER_CANDIDATES = [',', ';', '\t']

function countDelimiterOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === delimiter && !inQuotes) count++
  }
  return count
}

/**
 * Picks whichever candidate splits every sampled line into the same field count.
 * A single-line count isn't enough: a free-text cell (e.g. a Wordstat report-title
 * header cell) can contain more stray commas than the file's real, consistently-used
 * delimiter has occurrences of itself.
 */
function detectDelimiter(sampleLines: string[]): string {
  let best = ','
  let bestScore = -1
  for (const d of DELIMITER_CANDIDATES) {
    const counts = sampleLines.map((l) => countDelimiterOutsideQuotes(l, d))
    if (counts.every((c) => c === 0)) continue
    const consistent = counts.every((c) => c === counts[0])
    const score = (consistent ? 1000 : 0) + counts[0]
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return bestScore >= 0 ? best : ','
}

function splitLine(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((cell) => normalizeHeaderKey(cell))
}

function parseCsv(buffer: Buffer): Record<string, unknown>[] {
  const text = decodeBuffer(buffer)
  // Split on any of CRLF / lone CR / lone LF — native Wordstat exports use lone-CR line endings.
  const nonEmptyLines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0)
  if (nonEmptyLines.length === 0) return []

  const delimiter = detectDelimiter(nonEmptyLines.slice(0, 3))
  const headerCells = splitLine(nonEmptyLines[0], delimiter)
  const hasKnownHeader = headerCells.some((c) => HEADER_ALIASES[c])
  // A real header is never a bare number; a numeric first-line cell means this is
  // actually a headerless data row (e.g. a raw "keyword;count" dump with no header).
  const hasNumericCell = headerCells.some((c) => /\d/.test(c) && /^[\d\s.,]+$/.test(c))
  const isHeaderlessData = !hasKnownHeader && hasNumericCell

  const baseOptions = {
    delimiter,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
  }

  try {
    if (isHeaderlessData) {
      // No recognizable header — assume a bare native export in "keyword, frequency[, region]" order.
      return parse(text, { ...baseOptions, columns: ['keyword', 'frequency', 'region'] })
    }
    return parse(text, { ...baseOptions, columns: true })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ImportParseError(`Не удалось разобрать CSV (delimiter "${delimiter === '\t' ? 'tab' : delimiter}"): ${reason}`)
  }
}

/** Parses an uploaded Wordstat export (CSV or XLSX) into normalized keyword rows. */
export async function parseImportFile(buffer: Buffer, fileName: string): Promise<ImportRow[]> {
  const isXlsx = /\.xlsx?$/i.test(fileName)

  let rawRows: Record<string, unknown>[]
  try {
    rawRows = isXlsx ? await parseXlsx(buffer) : parseCsv(buffer)
  } catch (err) {
    if (err instanceof ImportParseError) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new ImportParseError(
      isXlsx ? `Не удалось прочитать XLSX-файл: ${reason}` : `Не удалось прочитать CSV-файл: ${reason}`,
    )
  }

  const rows: ImportRow[] = []
  for (const raw of rawRows) {
    const normalized = normalizeRow(raw)
    if (normalized) rows.push(normalized)
  }

  if (rows.length === 0) {
    throw new ImportParseError(
      'Не найдена колонка с ключевыми словами. Поддерживаемые заголовки: "Запрос", "Ключевое слово", "Keyword", "Phrase".',
    )
  }

  return rows
}
