import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import iconv from 'iconv-lite'
import ExcelJS from 'exceljs'
import { parseImportFile, ImportParseError } from './import-parse.ts'

// A representative native export from Яндекс.Вордстат → "Топ запросов":
// semicolon-delimited, Windows-1251 encoded, no BOM, no region column.
const NATIVE_WORDSTAT_CSV = 'Запрос;Число показов в месяц\r\nпластиковые окна;125808\r\nустановка окон;54200\r\n'

const FIXTURES_DIR = fileURLToPath(new URL('./__fixtures__', import.meta.url))

test('parses an actual Wordstat "Топ запросов" CSV export (real production file that used to fail)', async () => {
  // UTF-8 BOM, semicolon delimiter, lone-CR line endings, header "Запросы со словами;Число запросов;<report title with commas>".
  // Previously threw "Invalid Record Length" because the file was parsed with the default comma delimiter,
  // whose column count mismatched the semicolon-delimited data rows.
  const buffer = readFileSync(`${FIXTURES_DIR}/wordstat_top_queries.csv`)
  const rows = await parseImportFile(buffer, 'wordstat_top_queries.csv')

  assert.equal(rows.length, 396)
  assert.deepEqual(rows[0], { keyword: 'автоматизация бизнеса', frequency: 9025, region: '' })
  assert.deepEqual(rows[1], { keyword: 'автоматизация бизнес процессов', frequency: 3489, region: '' })
  assert.deepEqual(rows.at(-1), {
    keyword: 'yclients автоматизация бизнеса скачать бесплатно',
    frequency: 5,
    region: '',
  })
  assert.ok(rows.every((r) => r.keyword.length > 0 && Number.isFinite(r.frequency)))
})

test('parses a native Wordstat CSV export (cp1251, semicolon, RU headers, no region column)', async () => {
  const buffer = iconv.encode(NATIVE_WORDSTAT_CSV, 'win1251')
  const rows = await parseImportFile(buffer, 'wordstat_export.csv')

  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { keyword: 'пластиковые окна', frequency: 125808, region: '' })
  assert.deepEqual(rows[1], { keyword: 'установка окон', frequency: 54200, region: '' })
})

test('parses a UTF-8 CSV with BOM, comma delimiter, EN headers, and a region column', async () => {
  const csv = '﻿Keyword,Frequency,Region\r\nplastic windows,900,Moscow\r\n'
  const buffer = Buffer.from(csv, 'utf-8')
  const rows = await parseImportFile(buffer, 'export.csv')

  assert.deepEqual(rows, [{ keyword: 'plastic windows', frequency: 900, region: 'Moscow' }])
})

test('parses a tab-delimited export with mixed-case/whitespace header aliases', async () => {
  const csv = ' Ключевое Слово \t Частота \r\nокна пвх\t3400\r\n'
  const buffer = Buffer.from(csv, 'utf-8')
  const rows = await parseImportFile(buffer, 'export.csv')

  assert.deepEqual(rows, [{ keyword: 'окна пвх', frequency: 3400, region: '' }])
})

test('parses a headerless native export (bare "phrase, count" rows)', async () => {
  const csv = 'окна пвх;3400\r\nбалконные рамы;120\r\n'
  const buffer = Buffer.from(csv, 'utf-8')
  const rows = await parseImportFile(buffer, 'export.csv')

  assert.deepEqual(rows, [
    { keyword: 'окна пвх', frequency: 3400, region: '' },
    { keyword: 'балконные рамы', frequency: 120, region: '' },
  ])
})

test('strips thousands separators from frequency values', async () => {
  const csv = 'Keyword,Frequency\r\nwidgets,"12,345"\r\n'
  const buffer = Buffer.from(csv, 'utf-8')
  const rows = await parseImportFile(buffer, 'export.csv')

  assert.equal(rows[0].frequency, 12345)
})

test('still parses legacy UTF-8 comma CSV with a region column (no regression)', async () => {
  const csv = 'keyword,frequency,region\r\nfoo,10,RU\r\nbar,20,US\r\n'
  const buffer = Buffer.from(csv, 'utf-8')
  const rows = await parseImportFile(buffer, 'legacy.csv')

  assert.deepEqual(rows, [
    { keyword: 'foo', frequency: 10, region: 'RU' },
    { keyword: 'bar', frequency: 20, region: 'US' },
  ])
})

test('still parses XLSX uploads (no regression)', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.addRow(['Keyword', 'Frequency', 'Region'])
  sheet.addRow(['xlsx keyword', 42, 'RU'])
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())

  const rows = await parseImportFile(buffer, 'export.xlsx')
  assert.deepEqual(rows, [{ keyword: 'xlsx keyword', frequency: 42, region: 'RU' }])
})

test('throws a specific, technical reason when no keyword column is recognized', async () => {
  const csv = 'Foo,Bar\r\n1,2\r\n'
  const buffer = Buffer.from(csv, 'utf-8')

  await assert.rejects(() => parseImportFile(buffer, 'export.csv'), (err) => {
    assert.ok(err instanceof ImportParseError)
    assert.match(err.message, /Ключевое слово|Keyword/i)
    return true
  })
})

test('throws a specific, technical reason for a corrupt XLSX instead of a generic message', async () => {
  const buffer = Buffer.from('this is not a real xlsx zip', 'utf-8')

  await assert.rejects(() => parseImportFile(buffer, 'broken.xlsx'), (err) => {
    assert.ok(err instanceof ImportParseError)
    assert.match(err.message, /XLSX/)
    return true
  })
})
