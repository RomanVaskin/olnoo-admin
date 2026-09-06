import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { parseImportFile } from './import-parse.ts'
import { importKeywordRows } from './keywords-import.ts'

const FIXTURES_DIR = fileURLToPath(new URL('./__fixtures__', import.meta.url))

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

// End-to-end: preview parsing -> confirm import -> re-import the same file stays idempotent,
// using the real native Wordstat CSV export that used to fail (see import-parse.test.ts).
test('preview, confirm import, and idempotent re-import against a real DB', async (t) => {
  const pool = new Pool({ connectionString: DATABASE_URL })
  let clientId: number
  let projectId: number

  try {
    await pool.query('SELECT 1')
  } catch (err) {
    t.skip(`No reachable Postgres at DATABASE_URL — skipping DB integration test (${(err as Error).message})`)
    await pool.end()
    return
  }

  try {
    const client = await pool.query(
      `INSERT INTO clients (name) VALUES ('__test_wordstat_import__' || now()::text) RETURNING id`,
    )
    clientId = client.rows[0].id
    const domain = `__test-domain-${Date.now()}-${Math.random().toString(36).slice(2)}.example`
    const project = await pool.query(
      `INSERT INTO projects (client_id, name, domain, sitemap_url) VALUES ($1, 'test project', $2, 'https://example.com/sitemap.xml') RETURNING id`,
      [clientId, domain],
    )
    projectId = project.rows[0].id

    const buffer = readFileSync(`${FIXTURES_DIR}/wordstat_top_queries.csv`)
    const rows = await parseImportFile(buffer, 'wordstat_top_queries.csv')

    // Preview: matches what the API returns before confirm=true.
    const PREVIEW_LIMIT = 20
    const preview = rows.slice(0, PREVIEW_LIMIT)
    assert.equal(preview.length, PREVIEW_LIMIT)
    assert.equal(rows.length, 396)

    // Confirm import.
    const first = await importKeywordRows(pool, projectId, 'wordstat_top_queries.csv', rows)
    assert.equal(first.imported, 396)

    const afterFirst = await pool.query('SELECT count(*)::int AS n FROM keywords WHERE project_id = $1', [projectId])
    assert.equal(afterFirst.rows[0].n, 396)

    const sample = await pool.query(
      'SELECT frequency, region FROM keywords WHERE project_id = $1 AND query = $2',
      [projectId, 'автоматизация бизнеса'],
    )
    assert.equal(sample.rows[0].frequency, 9025)
    assert.equal(sample.rows[0].region, '')

    // Re-import the same file: row count must stay the same (upsert, not duplicate insert).
    const second = await importKeywordRows(pool, projectId, 'wordstat_top_queries.csv', rows)
    assert.equal(second.imported, 396)

    const afterSecond = await pool.query('SELECT count(*)::int AS n FROM keywords WHERE project_id = $1', [
      projectId,
    ])
    assert.equal(afterSecond.rows[0].n, 396, 'repeated import must not duplicate rows')

    const importsLog = await pool.query('SELECT count(*)::int AS n FROM imports WHERE project_id = $1', [projectId])
    assert.equal(importsLog.rows[0].n, 2, 'each confirm still logs its own import record')
  } finally {
    if (clientId!) await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    await pool.end()
  }
})
