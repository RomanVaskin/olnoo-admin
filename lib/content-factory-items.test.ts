import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  canGenerate,
  canApprove,
  canPublish,
  canReject,
  storeNewSourceMessages,
  listItems,
  getItem,
  setGeneratedContent,
  setItemStatus,
  countItemsByStatus,
} from './content-factory-items.ts'
import { createSource } from './content-factory-sources.ts'

// --- Pure: status transition guards ---

test('canGenerate: allowed from new/ready/needs_review/rejected/failed, not from processing/scheduled/published', () => {
  assert.equal(canGenerate('new'), true)
  assert.equal(canGenerate('ready'), true)
  assert.equal(canGenerate('needs_review'), true)
  assert.equal(canGenerate('rejected'), true)
  assert.equal(canGenerate('failed'), true)
  assert.equal(canGenerate('processing'), false)
  assert.equal(canGenerate('scheduled'), false)
  assert.equal(canGenerate('published'), false)
})

test('canApprove: only from needs_review', () => {
  assert.equal(canApprove('needs_review'), true)
  assert.equal(canApprove('ready'), false)
  assert.equal(canApprove('new'), false)
  assert.equal(canApprove('published'), false)
})

test('canPublish: only from ready — never straight from needs_review, never twice', () => {
  assert.equal(canPublish('ready'), true)
  assert.equal(canPublish('needs_review'), false)
  assert.equal(canPublish('scheduled'), false)
  assert.equal(canPublish('published'), false)
  assert.equal(canPublish('new'), false)
})

test('canReject: from new/ready/needs_review/failed, never from published/rejected/scheduled', () => {
  assert.equal(canReject('new'), true)
  assert.equal(canReject('ready'), true)
  assert.equal(canReject('needs_review'), true)
  assert.equal(canReject('failed'), true)
  assert.equal(canReject('published'), false)
  assert.equal(canReject('rejected'), false)
  assert.equal(canReject('scheduled'), false)
})

// --- DB integration (skipped without a reachable Postgres) ---

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
    const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_cf_items__' || clock_timestamp()::text) RETURNING id`)).rows[0].id as number
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

test('storeNewSourceMessages: the same external_id is never stored twice for the same source (DB-level dedup)', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const source = await createSource(pool, projectId, { type: 'telegram', handle: 'alexander_realty' })

    const msg = { externalId: '501', url: 'https://t.me/alexander_realty/501', text: 'Post', imageUrls: [], publishedAt: '' }
    const first = await storeNewSourceMessages(pool, projectId, source.id, [msg])
    assert.equal(first.length, 1)

    // A repeated check of the same source with the same message must never create a duplicate —
    // this is the task's own "Повторная проверка не создаёт дубликатов" requirement.
    const second = await storeNewSourceMessages(pool, projectId, source.id, [msg])
    assert.equal(second.length, 0)

    const all = await listItems(pool, projectId, { sourceId: source.id })
    assert.equal(all.length, 1)
  })
})

test('storeNewSourceMessages: a genuinely new message alongside an already-known one is stored once', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const source = await createSource(pool, projectId, { type: 'telegram', handle: 'alexander_realty' })

    await storeNewSourceMessages(pool, projectId, source.id, [
      { externalId: '601', url: 'u1', text: 'Post 1', imageUrls: [], publishedAt: '' },
    ])
    const second = await storeNewSourceMessages(pool, projectId, source.id, [
      { externalId: '601', url: 'u1', text: 'Post 1', imageUrls: [], publishedAt: '' },
      { externalId: '602', url: 'u2', text: 'Post 2', imageUrls: [], publishedAt: '' },
    ])
    assert.equal(second.length, 1)
    assert.equal(second[0].externalId, '602')
  })
})

test('requirement: project isolation — an item from project A is never visible/reachable under project B', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectA = await makeProject('AURELMAR')
    const projectB = await makeProject('DriveSet')
    const sourceA = await createSource(pool, projectA, { type: 'telegram', handle: 'alexander_realty' })
    const created = await storeNewSourceMessages(pool, projectA, sourceA.id, [
      { externalId: '701', url: 'u', text: 'Post', imageUrls: [], publishedAt: '' },
    ])
    const itemId = created[0].id

    assert.equal(await getItem(pool, projectB, itemId), null)
    assert.deepEqual(await listItems(pool, projectB, {}), [])
    assert.ok(await getItem(pool, projectA, itemId))
  })
})

test('setGeneratedContent / setItemStatus / countItemsByStatus', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const source = await createSource(pool, projectId, { type: 'telegram', handle: 'alexander_realty' })
    const created = await storeNewSourceMessages(pool, projectId, source.id, [
      { externalId: '801', url: 'u', text: 'Post', imageUrls: [], publishedAt: '' },
    ])
    const itemId = created[0].id

    const updated = await setGeneratedContent(pool, projectId, itemId, { title: 'T', text: 'Body', status: 'ready', reviewReason: '' })
    assert.equal(updated?.status, 'ready')
    assert.equal(updated?.generatedTitle, 'T')

    const rejected = await setItemStatus(pool, projectId, itemId, { status: 'rejected' })
    assert.equal(rejected?.status, 'rejected')

    const counts = await countItemsByStatus(pool, projectId)
    assert.equal(counts.rejected, 1)
  })
})
