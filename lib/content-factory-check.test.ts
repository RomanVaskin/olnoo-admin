import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { checkSourceNow } from './content-factory-check.ts'
import { createSource, getSource, type ContentFactorySource } from './content-factory-sources.ts'
import { listItems } from './content-factory-items.ts'

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
    const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_cf_check__' || clock_timestamp()::text) RETURNING id`)).rows[0].id as number
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

async function withFetch<T>(handler: (url: string) => { ok: boolean; status: number; text(): Promise<string> }, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => handler(url)) as unknown as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

const SAMPLE_HTML = `<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message" data-post="alexander_realty/900">
    <div class="tgme_widget_message_text">Новый проект на побережье.</div>
    <time datetime="2026-01-01T10:00:00+00:00">10:00</time>
  </div>
</div>`

test('checkSourceNow normalizes all supported Telegram address formats before fetching', async () => {
  for (const address of ['alexander_realty', '@alexander_realty', 'https://t.me/alexander_realty']) {
    let fetchedUrl = ''
    let recordedError = 'not checked'
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.startsWith('INSERT INTO content_factory_items')) return { rows: [] }
        if (sql.startsWith('UPDATE content_factory_sources')) {
          recordedError = params[0] as string
          return { rows: [] }
        }
        throw new Error(`Unexpected query: ${sql}`)
      },
    } as unknown as Pool
    const source = { id: 'source-1', projectId: 1, type: 'telegram', handle: address } as ContentFactorySource

    const result = await withFetch((url) => {
      fetchedUrl = url
      return { ok: true, status: 200, text: async () => SAMPLE_HTML }
    }, () => checkSourceNow(pool, source))

    assert.equal(result.error, '', address)
    assert.equal(recordedError, '', address)
    assert.equal(fetchedUrl, 'https://t.me/s/alexander_realty', address)
  }
})

test('checkSourceNow records a clear error for an invalid Telegram address without fetching', async () => {
  let recordedError = ''
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      assert.match(sql, /^UPDATE content_factory_sources/)
      recordedError = params[0] as string
      return { rows: [] }
    },
  } as unknown as Pool
  const source = { id: 'source-1', projectId: 1, type: 'telegram', handle: 'https://example.com/channel' } as ContentFactorySource

  const result = await withFetch(() => {
    throw new Error('Invalid address must not be fetched')
  }, () => checkSourceNow(pool, source))

  assert.match(result.error, /Invalid Telegram channel address/)
  assert.equal(recordedError, result.error)
  assert.deepEqual(result.created, [])
})

test('repeat source check does not retry an existing material with a persistent image error', async () => {
  let requests = 0
  const pool = { query: async (sql: string) => {
    if (sql.startsWith('INSERT INTO content_factory_items')) return { rows: [] }
    if (sql.startsWith('UPDATE content_factory_sources')) return { rows: [] }
    throw new Error(`Unexpected query: ${sql}`)
  } } as unknown as Pool
  const source = { id: 'source-1', projectId: 1, type: 'telegram', handle: '@alexander_realty', processingMode: 'copy', copyPermissionConfirmed: true } as ContentFactorySource
  const result = await withFetch(() => {
    requests++
    return { ok: true, status: 200, text: async () => SAMPLE_HTML }
  }, () => checkSourceNow(pool, source))
  assert.equal(requests, 1)
  assert.equal(result.error, '')
  assert.deepEqual(result.created, [])
})

test('checkSourceNow: fetches, stores new items, and records success on the source', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const source = await createSource(pool, projectId, { type: 'telegram', handle: 'alexander_realty' })

    const { created, error } = await withFetch(
      () => ({ ok: true, status: 200, text: async () => SAMPLE_HTML }),
      () => checkSourceNow(pool, source),
    )
    assert.equal(error, '')
    assert.equal(created.length, 1)

    const items = await listItems(pool, projectId, { sourceId: source.id })
    assert.equal(items.length, 1)

    const refreshed = await getSource(pool, projectId, source.id)
    assert.equal(refreshed?.lastError, '')
    assert.ok(refreshed?.lastCheckedAt)
  })
})

test('checkSourceNow: a repeat check of the same source never creates duplicates', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const source = await createSource(pool, projectId, { type: 'telegram', handle: 'alexander_realty' })

    await withFetch(() => ({ ok: true, status: 200, text: async () => SAMPLE_HTML }), () => checkSourceNow(pool, source))
    const second = await withFetch(() => ({ ok: true, status: 200, text: async () => SAMPLE_HTML }), () => checkSourceNow(pool, source))
    assert.equal(second.created.length, 0)

    const items = await listItems(pool, projectId, { sourceId: source.id })
    assert.equal(items.length, 1)
  })
})

test('checkSourceNow: an adapter failure is recorded on the source as lastError, never thrown', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const source = await createSource(pool, projectId, { type: 'telegram', handle: 'private_channel' })

    const { created, error } = await withFetch(() => ({ ok: false, status: 404, text: async () => '' }), () => checkSourceNow(pool, source))
    assert.equal(created.length, 0)
    assert.ok(error.length > 0)

    const refreshed = await getSource(pool, projectId, source.id)
    assert.equal(refreshed?.lastError, error)
  })
})

test('checkSourceNow: an unimplemented source type is a clear, recorded error — never a silent no-op', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const source = await createSource(pool, projectId, { type: 'rss', handle: 'https://example.com/feed' })

    const { created, error } = await checkSourceNow(pool, source)
    assert.equal(created.length, 0)
    assert.ok(/not implemented/i.test(error))

    const refreshed = await getSource(pool, projectId, source.id)
    assert.ok(/not implemented/i.test(refreshed?.lastError ?? ''))
  })
})
