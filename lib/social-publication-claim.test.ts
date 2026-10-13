import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { claimPublicationForSending, publicationClaimConflictResult } from './social-publication-claim.ts'

// DB integration (skipped without a reachable Postgres) — same convention as
// lib/social-publication-preflight-failure.test.ts / lib/social-scheduler-lock.test.ts.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(
  t: TestContext,
  fn: (pool: Pool, ctx: { projectId: number; postId: string; makePublication: (status?: string) => Promise<string> }) => Promise<void>,
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
    await pool.query(`INSERT INTO clients (name) VALUES ('__test_social_claim__' || clock_timestamp()::text) RETURNING id`)
  ).rows[0].id as number
  const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const projectId = (
    await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
      clientId,
      'claim test',
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
  const makePublication = async (status = 'draft') => {
    const publicationId = randomUUID()
    await pool.query(
      `INSERT INTO social_publications (id, project_id, social_post_id, platform, status) VALUES ($1, $2, $3, 'telegram', $4)`,
      [publicationId, projectId, postId, status],
    )
    return publicationId
  }

  try {
    await fn(pool, { projectId, postId, makePublication })
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId]) // cascades to projects -> social_posts/social_publications
    await pool.end()
  }
}

test('claimPublicationForSending: a draft/ready row is claimed, status flips to publishing', async (t) => {
  await withDb(t, async (pool, { projectId, makePublication }) => {
    const id = await makePublication('ready')
    const claim = await claimPublicationForSending(pool, id, projectId)
    assert.equal(claim.claimed, true)
    if (claim.claimed) {
      assert.equal(claim.row.status, 'publishing')
    }

    const { rows } = await pool.query('SELECT status FROM social_publications WHERE id = $1', [id])
    assert.equal(rows[0].status, 'publishing')
  })
})

test('claimPublicationForSending: already-published and already-publishing rows are refused, never re-claimed', async (t) => {
  await withDb(t, async (pool, { projectId, makePublication }) => {
    const publishedId = await makePublication('published')
    const published = await claimPublicationForSending(pool, publishedId, projectId)
    assert.deepEqual(published, { claimed: false, currentStatus: 'published' })

    const publishingId = await makePublication('publishing')
    const publishing = await claimPublicationForSending(pool, publishingId, projectId)
    assert.deepEqual(publishing, { claimed: false, currentStatus: 'publishing' })

    // Neither row was touched by the refused claim.
    const { rows } = await pool.query('SELECT id, status FROM social_publications WHERE id = ANY($1) ORDER BY id', [
      [publishedId, publishingId],
    ])
    for (const row of rows) {
      assert.ok(row.status === 'published' || row.status === 'publishing')
    }
  })
})

// The actual regression this guards against: a non-atomic "SELECT then check status then UPDATE"
// lets two concurrent callers both read the pre-claim status and both decide to proceed before
// either writes anything — this test fires two REAL concurrent claims (same row, same instant, via
// two separate pool connections, exactly like the "Publish selected channels" button and the
// scheduler racing) and proves only one of them ever wins.
test('claimPublicationForSending: two concurrent claims on the same row — exactly one wins, never both', async (t) => {
  await withDb(t, async (pool, { projectId, makePublication }) => {
    const id = await makePublication('ready')

    const [a, b] = await Promise.all([
      claimPublicationForSending(pool, id, projectId),
      claimPublicationForSending(pool, id, projectId),
    ])

    const winners = [a, b].filter((r) => r.claimed)
    const losers = [a, b].filter((r) => !r.claimed)
    assert.equal(winners.length, 1, 'exactly one of the two concurrent claims must win')
    assert.equal(losers.length, 1)
    if (!losers[0].claimed) {
      assert.equal(losers[0].currentStatus, 'publishing', "the loser must see the winner's new status")
    }

    const { rows } = await pool.query('SELECT status FROM social_publications WHERE id = $1', [id])
    assert.equal(rows[0].status, 'publishing')
  })
})

// A higher-concurrency version of the same guarantee — 10 simultaneous callers, still exactly one
// winner. Catches a claim implementation that's "atomic enough" for 2 but not for N (e.g. one that
// accidentally reads before writing in a way that happens to work out for exactly a pair).
test('claimPublicationForSending: 10 concurrent claims on the same row — still exactly one wins', async (t) => {
  await withDb(t, async (pool, { projectId, makePublication }) => {
    const id = await makePublication('ready')

    const results = await Promise.all(Array.from({ length: 10 }, () => claimPublicationForSending(pool, id, projectId)))
    const winners = results.filter((r) => r.claimed)
    assert.equal(winners.length, 1, 'exactly one of 10 concurrent claims must win')
  })
})

test('publicationClaimConflictResult: distinguishes "already published" from every other refusal reason, always 409', () => {
  assert.deepEqual(publicationClaimConflictResult('published'), { error: 'this publication is already published', status: 409 })
  const publishing = publicationClaimConflictResult('publishing')
  assert.equal(publishing.status, 409)
  assert.match(publishing.error, /already being published|never finished/)
  const unknown = publicationClaimConflictResult(null)
  assert.equal(unknown.status, 409)
})
