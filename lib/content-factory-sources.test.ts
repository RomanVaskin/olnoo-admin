import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { createSource, getSource, updateSource, deleteSource, recordSourceCheckResult, listSources, isSourceType, ContentFactorySourceError } from './content-factory-sources.ts'

test('isSourceType accepts only the known, schema-ready types', () => {
  assert.equal(isSourceType('telegram'), true)
  assert.equal(isSourceType('rss'), true)
  assert.equal(isSourceType('website'), true)
  assert.equal(isSourceType('youtube'), true)
  assert.equal(isSourceType('instagram'), false)
  assert.equal(isSourceType(123), false)
})

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(t: import('node:test').TestContext, fn: (pool: Pool, makeProject: (name: string) => Promise<number>) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT project_id FROM content_factory_sources LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the content_factory schema — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientIds: number[] = []
  const makeProject = async (name: string) => {
    const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_cf_sources__' || clock_timestamp()::text) RETURNING id`)).rows[0].id as number
    clientIds.push(clientId)
    const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    return (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
        clientId,
        name,
        `${slug}.example`,
        slug,
      ])
    ).rows[0].id as number
  }
  try {
    await fn(pool, makeProject)
  } finally {
    for (const clientId of clientIds) {
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    }
    await pool.end()
  }
}

test('createSource: rejects an unknown type and an empty handle', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    await assert.rejects(() => createSource(pool, projectId, { type: 'instagram', handle: 'x' }), ContentFactorySourceError)
    await assert.rejects(() => createSource(pool, projectId, { type: 'telegram', handle: '   ' }), ContentFactorySourceError)
  })
})

test('createSource / getSource / updateSource / deleteSource round-trip, enabled by default', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const source = await createSource(pool, projectId, { type: 'telegram', handle: 'alexander_realty' })
    assert.equal(source.enabled, true)
    assert.equal(source.handle, 'alexander_realty')

    const fetched = await getSource(pool, projectId, source.id)
    assert.equal(fetched?.id, source.id)

    const disabled = await updateSource(pool, projectId, source.id, { enabled: false })
    assert.equal(disabled?.enabled, false)

    const ok = await deleteSource(pool, projectId, source.id)
    assert.equal(ok, true)
    assert.equal(await getSource(pool, projectId, source.id), null)
  })
})

test('requirement: project isolation — a source from project A is never reachable under project B', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectA = await makeProject('AURELMAR')
    const projectB = await makeProject('DriveSet')
    const source = await createSource(pool, projectA, { type: 'telegram', handle: 'alexander_realty' })

    assert.equal(await getSource(pool, projectB, source.id), null)
    assert.equal(await updateSource(pool, projectB, source.id, { enabled: false }), null)
    assert.equal(await deleteSource(pool, projectB, source.id), false)
    assert.deepEqual(await listSources(pool, projectB), [])

    // The source must still be fully intact under its own project after every failed cross-project attempt.
    const stillThere = await getSource(pool, projectA, source.id)
    assert.equal(stillThere?.enabled, true)
  })
})

test('recordSourceCheckResult: records success (clears error) and failure independently per source', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const source = await createSource(pool, projectId, { type: 'telegram', handle: 'alexander_realty' })

    await recordSourceCheckResult(pool, source.id, projectId, 'some error')
    let fetched = await getSource(pool, projectId, source.id)
    assert.equal(fetched?.lastError, 'some error')
    assert.ok(fetched?.lastCheckedAt)

    await recordSourceCheckResult(pool, source.id, projectId, '')
    fetched = await getSource(pool, projectId, source.id)
    assert.equal(fetched?.lastError, '')
  })
})
