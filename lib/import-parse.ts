import ExcelJS from 'exceljs'
import { parse } from 'csv-parse/sync'

export type ImportRow = {
  keyword: string
  frequency: number
  region: string
}

const HEADER_ALIASES: Record<string, keyof ImportRow> = {
  keyword: 'keyword',
  query: 'keyword',
  'ключевое слово': 'keyword',
  'ключевой запрос': 'keyword',
  фраза: 'keyword',
  frequency: 'frequency',
  freq: 'frequency',
  частота: 'frequency',
  показы: 'frequency',
  region: 'region',
  регион: 'region',
}

function normalizeRow(raw: Record<string, unknown>): ImportRow | null {
  const row: Partial<ImportRow> = {}

  for (const [rawKey, value] of Object.entries(raw)) {
    const field = HEADER_ALIASES[rawKey.trim().toLowerCase()]
    if (!field) continue

    if (field === 'frequency') {
      const numeric =
        typeof value === 'number' ? value : parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10)
      row.frequency = Number.isFinite(numeric) ? numeric : 0
    } else {
      row[field] = String(value ?? '').trim()
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

function parseCsv(buffer: Buffer): Record<string, unknown>[] {
  return parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  })
}

/** Parses an uploaded Wordstat export (CSV or XLSX) into normalized keyword rows. */
export async function parseImportFile(buffer: Buffer, fileName: string): Promise<ImportRow[]> {
  const isXlsx = /\.xlsx?$/i.test(fileName)
  const rawRows = isXlsx ? await parseXlsx(buffer) : parseCsv(buffer)

  const rows: ImportRow[] = []
  for (const raw of rawRows) {
    const normalized = normalizeRow(raw)
    if (normalized) rows.push(normalized)
  }
  return rows
}
