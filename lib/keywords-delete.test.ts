import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { deleteImport, previewImportDelete } from './keywords-delete.ts'
import { importKeywordFiles, KeywordImportError, listImportHistory } from './keywords-import.ts'

// DB integration tests for «Удалить импорт»; skip without Postgres (migrations through 0011).
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
  const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_delete__' || clock_timestamp()::text) RETURNING id`)).rows[0].id
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

const queries = async (pool: Pool, projectId: number) =>
  (await pool.query('SELECT query FROM keywords WHERE project_id = $1 ORDER BY query', [projectId])).rows.map((r) => r.query)

/** What the pre-batch code did: keywords + imports rows in one transaction, batch_id NULL. Returns the history key. */
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
      await client.query(`INSERT INTO imports (project_id, file_name, rows_count) VALUES ($1, $2, $3)`, [projectId, f.fileName, f.rows.length])
    }
    const ts = (await client.query('SELECT now()::text AS ts')).rows[0].ts as string
    await client.query('COMMIT')
    return `l:${projectId}|${ts}`
  } finally {
    client.release()
  }
}

async function linkToCluster(pool: Pool, projectId: number, query: string) {
  const id = (await pool.query('SELECT id FROM keywords WHERE project_id = $1 AND query = $2', [projectId, query])).rows[0].id
  const cluster = (await pool.query(`INSERT INTO seo_clusters (project_id, name) VALUES ($1, 'c') RETURNING id`, [projectId])).rows[0].id
  await pool.query('INSERT INTO seo_cluster_keywords (cluster_id, keyword_id) VALUES ($1, $2)', [cluster, id])
}

test('legacy import delete: only keywords it created and nothing references go; history kept as Deleted', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    await legacyImport(pool, p, [{ fileName: 'olnoo.csv', rows: [kw('автоматизация бизнеса'), kw('оклейка авто', 5)] }])
    const key = await legacyImport(pool, p, [
      { fileName: 'okleyka.xlsx', rows: [kw('оклейка авто', 12000), kw('оклейка авто пленкой')] },
      { fileName: 'ppf.xlsx', rows: [kw('полиуретановая пленка'), kw('бронепленка')] },
    ])
    await linkToCluster(pool, p, 'бронепленка')

    const preview = await previewImportDelete(pool, key)
    assert.deepEqual(
      { files: preview.files, keywords: preview.keywords, toDelete: preview.toDelete, existedBefore: preview.existedBefore, linked: preview.linked, notFound: preview.notFound },
      { files: 2, keywords: 3, toDelete: 2, existedBefore: 1, linked: [{ query: 'бронепленка', region: '' }], notFound: null },
    )
    assert.equal((await queries(pool, p)).length, 5, 'preview writes nothing')

    const done = await deleteImport(pool, key)
    assert.equal(done.deleted, 2)
    // Pre-existing keyword (frequency was overwritten — not restorable) and the linked one stay.
    assert.deepEqual(await queries(pool, p), ['автоматизация бизнеса', 'бронепленка', 'оклейка авто'])
    const history = await listImportHistory(pool, { limit: 10, offset: 0, projectId: p })
    assert.deepEqual(history.groups.map((g) => g.status), ['Deleted', 'Imported'])
    assert.equal(history.groups[0].filesCount, 2)
  })
})

test('batch delete uses the recorded provenance; pre-existing and linked keywords stay', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    await importKeywordFiles(pool, p, [{ fileName: 'own.csv', rows: [kw('оклейка авто', 5)] }])
    const wrong = await importKeywordFiles(pool, p, [
      { fileName: 'a.xlsx', rows: [kw('оклейка авто', 12000), kw('антигравийная пленка'), kw('виниловая оклейка')] },
      { fileName: 'b.xlsx', rows: [kw('защитная пленка')] },
    ])
    await linkToCluster(pool, p, 'виниловая оклейка')
    // A keyword the batch created, then removed and re-created by someone else: no longer provable.
    await pool.query('DELETE FROM keywords WHERE project_id = $1 AND query = $2', [p, 'защитная пленка'])
    await importKeywordFiles(pool, p, [{ fileName: 'later.csv', rows: [kw('защитная пленка')] }])

    const preview = await previewImportDelete(pool, `b:${wrong.batchId}`)
    assert.deepEqual(
      { files: preview.files, keywords: preview.keywords, toDelete: preview.toDelete, existedBefore: preview.existedBefore, linked: preview.linked.length, notFound: preview.notFound },
      { files: 2, keywords: 4, toDelete: 1, existedBefore: 1, linked: 1, notFound: 1 },
    )
    const done = await deleteImport(pool, `b:${wrong.batchId}`)
    assert.equal(done.deleted, 1)
    assert.deepEqual(await queries(pool, p), ['виниловая оклейка', 'защитная пленка', 'оклейка авто'])
    assert.equal((await pool.query('SELECT status FROM import_batches WHERE id = $1', [wrong.batchId])).rows[0].status, 'Deleted')
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM imports WHERE batch_id = $1 AND status = 'Deleted'`, [wrong.batchId])).rows[0].n, 2)
  })
})

test('deleting twice is refused and changes nothing', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const key = await legacyImport(pool, p, [{ fileName: 'x.csv', rows: [kw('x'), kw('y')] }])
    await deleteImport(pool, key)
    // Same keywords imported again later: they now belong to a newer import and must survive.
    const again = await importKeywordFiles(pool, p, [{ fileName: 'x.csv', rows: [kw('x')] }])
    await assert.rejects(deleteImport(pool, key), KeywordImportError)
    await assert.rejects(previewImportDelete(pool, key), KeywordImportError)
    assert.deepEqual(await queries(pool, p), ['x'])
    await deleteImport(pool, `b:${again.batchId}`)
    await assert.rejects(deleteImport(pool, `b:${again.batchId}`), KeywordImportError)
    assert.deepEqual(await queries(pool, p), [])
  })
})

test('unknown or malformed import keys are rejected', async (t) => {
  await withDb(t, async (pool) => {
    for (const key of ['b:999999999', 'b:abc', 'l:999999999|2026-10-02 04:04:52.1+00', 'nonsense']) {
      await assert.rejects(previewImportDelete(pool, key), KeywordImportError, key)
    }
  })
})

test('a failing delete rolls back: keywords and history untouched', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const key = await legacyImport(pool, p, [{ fileName: 'x.csv', rows: [kw('x'), kw('y')] }])
    // Make the status update fail inside the transaction, after the keyword DELETE ran.
    await pool.query(`ALTER TABLE imports ADD CONSTRAINT __test_no_deleted CHECK (status <> 'Deleted') NOT VALID`)
    try {
      await assert.rejects(deleteImport(pool, key))
    } finally {
      await pool.query('ALTER TABLE imports DROP CONSTRAINT __test_no_deleted')
    }
    assert.deepEqual(await queries(pool, p), ['x', 'y'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM imports WHERE project_id = $1 AND status = 'Imported'`, [p])).rows[0].n, 1)
  })
})
