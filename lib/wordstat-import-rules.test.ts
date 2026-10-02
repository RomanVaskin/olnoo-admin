import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importSelectionError, isSupportedImportFile, mergeImportRows, MAX_IMPORT_FILES } from './wordstat-import-rules.ts'

const file = (name: string, size = 40_000) => ({ name, size })

test('30 Wordstat files fit one batch; 31 do not', () => {
  const thirty = Array.from({ length: MAX_IMPORT_FILES }, (_, i) => file(`wordstat-${i}.xlsx`))
  assert.equal(importSelectionError(thirty), null)
  assert.match(importSelectionError([...thirty, file('extra.xlsx')])!, /^31 файл · 1\.2 MB\. Максимум 30 файлов и 10\.0 MB/)
})

test('total and per-file size limits give a readable reason', () => {
  assert.match(importSelectionError([file('a.xlsx', 4.5 * 1024 * 1024), file('b.xlsx', 4.5 * 1024 * 1024), file('c.xlsx', 2 * 1024 * 1024)])!, /^3 файла · 11\.0 MB\. Максимум/)
  assert.equal(importSelectionError([file('big.xlsx', 6 * 1024 * 1024)]), 'big.xlsx: 6.0 MB. Максимум 5.0 MB на файл.')
})

test('only .csv and .xlsx are supported', () => {
  assert.equal(isSupportedImportFile('оклейка.CSV'), true)
  assert.equal(isSupportedImportFile('пленка.xlsx'), true)
  assert.equal(isSupportedImportFile('old.xls'), false)
  assert.equal(isSupportedImportFile('report.pdf'), false)
})

test('a keyword present in several files is one keyword; highest frequency wins', () => {
  assert.deepEqual(
    mergeImportRows([
      { keyword: 'оклейка авто', frequency: 100, region: '' },
      { keyword: 'полиуретановая пленка', frequency: 50, region: '' },
      { keyword: 'оклейка авто', frequency: 120, region: '' },
      { keyword: 'оклейка авто', frequency: 30, region: 'Москва' },
    ]),
    [
      { keyword: 'оклейка авто', frequency: 120, region: '' },
      { keyword: 'полиуретановая пленка', frequency: 50, region: '' },
      { keyword: 'оклейка авто', frequency: 30, region: 'Москва' },
    ],
  )
})
