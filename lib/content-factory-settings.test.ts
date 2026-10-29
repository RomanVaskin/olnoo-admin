import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { getSettings, saveSettings, isContentFactoryMode } from './content-factory-settings.ts'

test('isContentFactoryMode accepts only the three defined modes', () => {
  assert.equal(isContentFactoryMode('manual'), true)
  assert.equal(isContentFactoryMode('auto_review'), true)
  assert.equal(isContentFactoryMode('auto_publish'), true)
  assert.equal(isContentFactoryMode('full_auto'), false)
})

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(t: import('node:test').TestContext, fn: (pool: Pool, makeProject: (name: string) => Promise<number>) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT project_id FROM content_factory_settings LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the content_factory schema — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientIds: number[] = []
  const makeProject = async (name: string) => {
    const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_cf_settings__' || clock_timestamp()::text) RETURNING id`)).rows[0].id as number
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

test('requirement: a project with no saved settings yet defaults to manual mode, auto_publish off', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const settings = await getSettings(pool, projectId)
    assert.equal(settings.mode, 'manual')
    assert.equal(settings.autoPublish, false)
    assert.equal(settings.requiresApproval, true)
  })
})

test('saveSettings: upserts and round-trips every field, is idempotent on a repeat save', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    const saved = await saveSettings(pool, projectId, {
      mode: 'auto_review',
      language: 'ru',
      allowedTopics: 'недвижимость, инвестиции',
      maxPostsPerDay: 2,
      schedule: 'daily-09:00',
      requiresApproval: true,
      autoPublish: false,
    })
    assert.equal(saved.mode, 'auto_review')
    assert.equal(saved.maxPostsPerDay, 2)

    const fetched = await getSettings(pool, projectId)
    assert.deepEqual(fetched, saved)

    const savedAgain = await saveSettings(pool, projectId, { maxPostsPerDay: 5 })
    assert.equal(savedAgain.maxPostsPerDay, 5)
    assert.equal(savedAgain.mode, 'auto_review', 'a partial save must not reset fields it did not touch')
  })
})

test('requirement: project isolation — settings saved for project A never affect project B\'s defaults', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectA = await makeProject('AURELMAR')
    const projectB = await makeProject('DriveSet')
    await saveSettings(pool, projectA, { mode: 'auto_publish', autoPublish: true })

    const settingsB = await getSettings(pool, projectB)
    assert.equal(settingsB.mode, 'manual')
    assert.equal(settingsB.autoPublish, false)
  })
})

test('requirement: an unknown mode value is rejected, never silently stored', async (t) => {
  await withDb(t, async (pool, makeProject) => {
    const projectId = await makeProject('AURELMAR')
    // @ts-expect-error deliberately passing an invalid mode to prove it's rejected, not just typed away
    const saved = await saveSettings(pool, projectId, { mode: 'full_auto' })
    assert.equal(saved.mode, 'manual')
  })
})
