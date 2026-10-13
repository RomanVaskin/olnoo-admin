import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { recordPublicationPreflightFailure } from './social-publication-preflight-failure.ts'

// DB integration (skipped without a reachable Postgres that has the social_posts/social_publications
// tables through migration 0007) — same convention as lib/crm-observer.test.ts's own "DB
// integration" section.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(
  t: TestContext,
  fn: (pool: Pool, ctx: { projectId: number; postId: string; publicationId: string }) => Promise<void>,
) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT id FROM social_publications LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the social_publications table — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }

  const clientId = (
    await pool.query(`INSERT INTO clients (name) VALUES ('__test_social_preflight__' || clock_timestamp()::text) RETURNING id`)
  ).rows[0].id as number
  const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const projectId = (
    await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
      clientId,
      'preflight test',
      `${slug}.example`,
      slug,
    ])
  ).rows[0].id as number

  const postId = randomUUID()
  await pool.query(
    `INSERT INTO social_posts (id, project_id, topic, category, body, channels, publish_date, status)
     VALUES ($1, $2, 'test post', '', '', 'telegram', '', 'ready')`,
    [postId, projectId],
  )
  const publicationId = randomUUID()
  await pool.query(
    `INSERT INTO social_publications (id, project_id, social_post_id, platform, status) VALUES ($1, $2, $3, 'telegram', 'draft')`,
    [publicationId, projectId, postId],
  )

  try {
    await fn(pool, { projectId, postId, publicationId })
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId]) // cascades to projects -> social_posts/social_publications
    await pool.end()
  }
}

test('recordPublicationPreflightFailure: writes status=failed and the given message onto the row', async (t) => {
  await withDb(t, async (pool, { projectId, publicationId }) => {
    await recordPublicationPreflightFailure(pool, publicationId, projectId, 'no Telegram account configured for this project')

    const { rows } = await pool.query('SELECT status, error FROM social_publications WHERE id = $1', [publicationId])
    assert.equal(rows[0].status, 'failed')
    assert.equal(rows[0].error, 'no Telegram account configured for this project')
  })
})

// The actual bug this fixes: before this helper existed, a pre-flight problem (no account, no
// content, no token, ...) returned an {error, status} to the caller but never touched the row at
// all — it stayed in whatever non-terminal status it already had, so lib/social-scheduler.ts's own
// `WHERE pub.status <> 'published'` candidate query kept matching it forever.
test('recordPublicationPreflightFailure: moves a row OUT of the scheduler\'s "still pending" status set (draft/ready) into the terminal "failed" status', async (t) => {
  await withDb(t, async (pool, { projectId, publicationId }) => {
    const { rows: before } = await pool.query('SELECT status FROM social_publications WHERE id = $1', [publicationId])
    assert.equal(before[0].status, 'draft')

    await recordPublicationPreflightFailure(pool, publicationId, projectId, 'post has no content to publish')

    const { rows: after } = await pool.query('SELECT status FROM social_publications WHERE id = $1', [publicationId])
    assert.equal(after[0].status, 'failed')
    assert.notEqual(after[0].status, 'draft')
    assert.notEqual(after[0].status, 'ready')
  })
})

test('recordPublicationPreflightFailure: scoped by id AND project_id — a no-op for the wrong project', async (t) => {
  await withDb(t, async (pool, { publicationId }) => {
    const wrongProjectId = 999999999
    await recordPublicationPreflightFailure(pool, publicationId, wrongProjectId, 'should not apply')

    const { rows } = await pool.query('SELECT status, error FROM social_publications WHERE id = $1', [publicationId])
    assert.equal(rows[0].status, 'draft', 'the row must be untouched when the project_id does not match')
    assert.equal(rows[0].error, '')
  })
})
