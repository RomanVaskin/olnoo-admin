import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { Pool } from 'pg'
import { parseImportFile } from './import-parse.ts'
import { importKeywordFiles, KeywordImportError, listImportHistory } from './keywords-import.ts'
import { previewKeywordTransfer, transferKeywords } from './keywords-transfer.ts'

// DB integration tests for batches and transfers. Like keywords-import.test.ts they skip when no
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

/** What the pre-batch code did: keywords + one imports row per file in one transaction, batch_id NULL. */
async function legacyImport(pool: Pool, projectId: number, files: { fileName: string; rows: ReturnType<typeof kw>[] }[]) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const row of files.flatMap((f) => f.rows)) {
      await client.query(
        `INSERT INTO keywords (project_id, query, frequency, region, status) VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (project_id, query, region) DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = now()`,
        [projectId, row.keyword, row.frequency, row.region],
      )
    }
    for (const f of files) {
      await client.query(`INSERT INTO imports (project_id, file_name, rows_count, status) VALUES ($1, $2, $3, 'Imported')`, [
        projectId,
        f.fileName,
        f.rows.length,
      ])
    }
    const ts = (await client.query(`SELECT now()::text AS ts`)).rows[0].ts as string
    await client.query('COMMIT')
    return `l:${projectId}|${ts}`
  } finally {
    client.release()
  }
}

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

test('legacy import transfer: preview, then only keywords created by that import leave the source', async (t) => {
  await withDb(t, async (pool, project) => {
    const olnoo = await project()
    const driveset = await project()
    // OLNOO's own semantics, imported earlier; "автоматизация бизнеса" is linked to a cluster.
    await legacyImport(pool, olnoo, [{ fileName: 'olnoo.csv', rows: [kw('автоматизация бизнеса'), kw('оклейка авто', 5)] }])
    const linkedId = (await pool.query('SELECT id FROM keywords WHERE project_id = $1 AND query = $2', [olnoo, 'автоматизация бизнеса'])).rows[0].id
    // The mistaken DriveSet import into OLNOO (two files; "оклейка авто" already existed in OLNOO).
    const driveFiles = [
      { fileName: 'okleyka.xlsx', rows: [kw('оклейка авто', 12000), kw('оклейка авто пленкой', 3100)] },
      { fileName: 'ppf.xlsx', rows: [kw('полиуретановая пленка', 8000), kw('бронепленка на авто', 900)] },
    ]
    const legacyKey = await legacyImport(pool, olnoo, driveFiles)
    // A DriveSet keyword created by the mistaken import and since used in an OLNOO cluster.
    const brone = (await pool.query('SELECT id FROM keywords WHERE project_id = $1 AND query = $2', [olnoo, 'бронепленка на авто'])).rows[0].id
    const cluster = (await pool.query(`INSERT INTO seo_clusters (project_id, name, intent) VALUES ($1, 'c', 'commercial') RETURNING id`, [olnoo])).rows[0].id
    await pool.query('INSERT INTO seo_cluster_keywords (cluster_id, keyword_id) VALUES ($1, $2), ($1, $3)', [cluster, brone, linkedId])
    await importKeywordFiles(pool, driveset, [{ fileName: 'existing.csv', rows: [kw('полиуретановая пленка', 7000)] }])

    const request = { sourceProjectId: olnoo, targetProjectId: driveset, scope: { legacyKeys: [legacyKey] }, files: driveFiles }
    const preview = await previewKeywordTransfer(pool, request)
    assert.deepEqual(preview.target, { new: 3, existing: 1 })
    assert.deepEqual(preview.source, { found: 4, toDelete: 2, missing: 0 })
    assert.deepEqual(
      preview.conflicts.map((c) => `${c.query}:${c.reason}`).sort(),
      ['бронепленка на авто:linked', 'оклейка авто:existed_before'],
    )
    assert.equal(await keywordsIn(pool, olnoo), 5, 'preview writes nothing')

    const done = await transferKeywords(pool, request)
    assert.equal(done.deleted, 2)
    const left = (await pool.query('SELECT query FROM keywords WHERE project_id = $1 ORDER BY query', [olnoo])).rows.map((r) => r.query)
    assert.deepEqual(left, ['автоматизация бизнеса', 'бронепленка на авто', 'оклейка авто'])
    assert.equal(await keywordsIn(pool, driveset), 4)
    assert.equal(await count(pool, `SELECT count(*)::int AS n FROM imports WHERE project_id = $1 AND status = 'Moved'`, [olnoo]), 2)
    assert.equal(await count(pool, `SELECT count(*)::int AS n FROM imports WHERE project_id = $1 AND status = 'Imported'`, [olnoo]), 1)
    const transfer = (await pool.query(`SELECT kind, source_project_id, files_count, keywords_count FROM import_batches WHERE id = $1`, [done.batchId])).rows[0]
    assert.deepEqual(transfer, { kind: 'transfer', source_project_id: olnoo, files_count: 2, keywords_count: 4 })

    // Already moved: a second transfer of the same import is refused.
    await assert.rejects(transferKeywords(pool, request), KeywordImportError)
  })
})

test('batch transfer needs no files and keeps keywords the batch did not create', async (t) => {
  await withDb(t, async (pool, project) => {
    const olnoo = await project()
    const driveset = await project()
    await importKeywordFiles(pool, olnoo, [{ fileName: 'olnoo.csv', rows: [kw('оклейка авто', 5)] }])
    const wrong = await importKeywordFiles(pool, olnoo, [
      { fileName: 'a.xlsx', rows: [kw('оклейка авто', 12000), kw('антигравийная пленка', 5400)] },
    ])
    const request = { sourceProjectId: olnoo, targetProjectId: driveset, scope: { batchIds: [wrong.batchId] } }
    const preview = await previewKeywordTransfer(pool, request)
    assert.deepEqual(preview.source, { found: 2, toDelete: 1, missing: 0 })
    assert.deepEqual(preview.conflicts, [{ query: 'оклейка авто', region: '', reason: 'existed_before' }])
    await transferKeywords(pool, request)
    assert.deepEqual((await pool.query('SELECT query FROM keywords WHERE project_id = $1', [olnoo])).rows.map((r) => r.query), ['оклейка авто'])
    assert.equal(await keywordsIn(pool, driveset), 2)
    assert.equal((await pool.query('SELECT status FROM import_batches WHERE id = $1', [wrong.batchId])).rows[0].status, 'Moved')
  })
})

test('transfer guards: same project, wrong project, legacy without files', async (t) => {
  await withDb(t, async (pool, project) => {
    const a = await project()
    const b = await project()
    const key = await legacyImport(pool, a, [{ fileName: 'x.csv', rows: [kw('x')] }])
    const files = [{ fileName: 'x.csv', rows: [kw('x')] }]
    await assert.rejects(previewKeywordTransfer(pool, { sourceProjectId: a, targetProjectId: a, scope: { legacyKeys: [key] }, files }), KeywordImportError)
    await assert.rejects(previewKeywordTransfer(pool, { sourceProjectId: a, targetProjectId: 999999999, scope: { legacyKeys: [key] }, files }), KeywordImportError)
    await assert.rejects(previewKeywordTransfer(pool, { sourceProjectId: b, targetProjectId: a, scope: { legacyKeys: [key] }, files }), KeywordImportError)
    await assert.rejects(previewKeywordTransfer(pool, { sourceProjectId: a, targetProjectId: b, scope: { legacyKeys: [key] } }), KeywordImportError)
  })
})

test('a failing transfer rolls back: source untouched, target empty, history unchanged', async (t) => {
  await withDb(t, async (pool, project) => {
    const src = await project()
    const dst = await project()
    const files = [{ fileName: 'a.csv', rows: [kw('оклейка авто'), kw('полировка авто')] }]
    const key = await legacyImport(pool, src, files)
    const broken = [{ fileName: 'a.csv', rows: [kw('оклейка авто'), kw('полировка авто', 2 ** 40)] }]
    await assert.rejects(transferKeywords(pool, { sourceProjectId: src, targetProjectId: dst, scope: { legacyKeys: [key] }, files: broken }))
    assert.equal(await keywordsIn(pool, src), 2)
    assert.equal(await keywordsIn(pool, dst), 0)
    assert.equal(await count(pool, `SELECT count(*)::int AS n FROM imports WHERE project_id = $1 AND status = 'Imported'`, [src]), 1)
    assert.equal(await count(pool, 'SELECT count(*)::int AS n FROM import_batches WHERE project_id = $1', [dst]), 0)
  })
})
