import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { Pool } from 'pg'
import { parseImportFile } from './import-parse.ts'
import { importKeywordFiles, KeywordImportError, listImportHistory } from './keywords-import.ts'

// DB integration tests for import batches. Like keywords-import.test.ts they skip when no
// Postgres (with migrations through 0011 applied) is reachable at DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

const kw = (keyword: string, frequency = 100, region = '') => ({ keyword, frequency, region })

async function withDb(t: TestContext, fn: (pool: Pool, project: () => Promise<number>) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT 1 FROM import_batches LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with migration 0011 at DATABASE_URL — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_batches__' || clock_timestamp()::text) RETURNING id`)).rows[0].id
  const project = async () =>
    (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url) VALUES ($1, 'p', $2, '') RETURNING id`, [
        clientId,
        `__test-${Date.now()}-${Math.random().toString(36).slice(2)}.example`,
      ])
    ).rows[0].id as number
  try {
    await fn(pool, project)
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    await pool.end()
  }
}

const count = async (pool: Pool, sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0].n as number
const keywordsIn = (pool: Pool, projectId: number) =>
  count(pool, 'SELECT count(*)::int AS n FROM keywords WHERE project_id = $1', [projectId])

test('multi-file import is one batch: merged keywords, one imports row per file', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const files = [
      { fileName: 'okleyka.xlsx', rows: [kw('оклейка авто'), kw('оклейка авто пленкой', 40)] },
      { fileName: 'ppf.csv', rows: [kw('оклейка авто', 120), kw('полиуретановая пленка', 70)] },
    ]
    const result = await importKeywordFiles(pool, p, files)
    assert.deepEqual({ ...result, batchId: 0 }, { batchId: 0, imported: 3, created: 3, updated: 0, files: 2 })
    assert.equal(await keywordsIn(pool, p), 3)
    // Duplicate keyword between files: one row, highest frequency.
    assert.equal((await pool.query('SELECT frequency FROM keywords WHERE project_id = $1 AND query = $2', [p, 'оклейка авто'])).rows[0].frequency, 120)
    const batch = (await pool.query('SELECT files_count, keywords_count, kind, status FROM import_batches WHERE id = $1', [result.batchId])).rows[0]
    assert.deepEqual(batch, { files_count: 2, keywords_count: 3, kind: 'import', status: 'Imported' })
    assert.equal(await count(pool, 'SELECT count(*)::int AS n FROM imports WHERE batch_id = $1', [result.batchId]), 2)
    assert.equal(await count(pool, 'SELECT count(*)::int AS n FROM import_batch_keywords WHERE batch_id = $1 AND created', [result.batchId]), 3)

    const history = await listImportHistory(pool, { limit: 10, offset: 0, projectId: p })
    assert.equal(history.groups.length, 1)
    assert.deepEqual(history.groups[0].files.map((f) => f.fileName), ['okleyka.xlsx', 'ppf.csv'])
  })
})

test('repeated import of the same files updates, never duplicates', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const files = [{ fileName: 'a.csv', rows: [kw('химчистка салона'), kw('полировка авто')] }]
    await importKeywordFiles(pool, p, files)
    const again = await importKeywordFiles(pool, p, files)
    assert.equal(again.created, 0)
    assert.equal(again.updated, 2)
    assert.equal(await keywordsIn(pool, p), 2)
    assert.equal(await count(pool, 'SELECT count(*)::int AS n FROM import_batches WHERE project_id = $1', [p]), 2)
  })
})

test('30 real XLSX Wordstat files import as one batch', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const files = []
    for (let i = 0; i < 30; i++) {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('Wordstat')
      ws.addRow(['Запрос', 'Число запросов'])
      ws.addRow(['оклейка авто', 12000]) // in every file
      for (let r = 0; r < 50; r++) ws.addRow([`запрос ${i}-${r}`, 1000 - r])
      const buffer = Buffer.from(await wb.xlsx.writeBuffer())
      files.push({ fileName: `wordstat-${i}.xlsx`, rows: await parseImportFile(buffer, `wordstat-${i}.xlsx`) })
    }
    const result = await importKeywordFiles(pool, p, files)
    assert.equal(result.files, 30)
    assert.equal(result.imported, 30 * 50 + 1)
    assert.equal(await keywordsIn(pool, p), 1501)
    assert.equal(await count(pool, 'SELECT count(*)::int AS n FROM imports WHERE batch_id = $1', [result.batchId]), 30)
  })
})

test('unknown project is rejected and nothing is written', async (t) => {
  await withDb(t, async (pool) => {
    const before = await count(pool, 'SELECT count(*)::int AS n FROM import_batches', [])
    await assert.rejects(importKeywordFiles(pool, 999999999, [{ fileName: 'a.csv', rows: [kw('x')] }]), KeywordImportError)
    await assert.rejects(importKeywordFiles(pool, 'abc', [{ fileName: 'a.csv', rows: [kw('x')] }]), KeywordImportError)
    assert.equal(await count(pool, 'SELECT count(*)::int AS n FROM import_batches', []), before)
  })
})

test('a failing import rolls back the whole batch', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const files = [
      { fileName: 'ok.csv', rows: [kw('оклейка авто')] },
      { fileName: 'bad.csv', rows: [kw('переполнение', 2 ** 40)] }, // integer overflow inside the upsert
    ]
    await assert.rejects(importKeywordFiles(pool, p, files))
    assert.equal(await keywordsIn(pool, p), 0)
    assert.equal(await count(pool, 'SELECT count(*)::int AS n FROM import_batches WHERE project_id = $1', [p]), 0)
    assert.equal(await count(pool, 'SELECT count(*)::int AS n FROM imports WHERE project_id = $1', [p]), 0)
  })
})
