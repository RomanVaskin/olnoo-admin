import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import type { AiRouterMessage } from './ai-router.ts'
import { MERGE_SYSTEM_PROMPT, stem } from './seo-clustering-batch.ts'
import { createClusteringJob, generateClustersForProject, runClusteringJob, viewClusteringJob } from './seo-clustering.ts'

// Batched clustering against a real Postgres with a fake AI Router; skipped without a DB.
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

const SERVICES = ['оклейка', 'полировка', 'химчистка', 'тонировка', 'бронирование']
const CARS = ['авто', 'автомобиля', 'машины']
const SYNONYMS: Record<string, string> = { авто: 'car', автомобиля: 'car', машины: 'car' }

/** 5 services × 3 synonyms for "car" × 350 modifiers = 5 250 keywords, 5 real search intents. */
function dataset(modifiers = 350) {
  const rows: { query: string; frequency: number }[] = []
  for (const s of SERVICES) for (const c of CARS) for (let m = 0; m < modifiers; m++) rows.push({ query: `${s} ${c} вариант ${m}`, frequency: 1000 - m })
  return rows
}

function promptKeywords(content: string): string[] {
  const block = content.slice(content.indexOf('\n') + 1, content.indexOf('\n\nEXISTING PAGES'))
  return block
    .split('\n')
    .map((line) => /^- (.*) \(frequency: -?\d+\)$/.exec(line)?.[1])
    .filter((q): q is string => Boolean(q))
}

/**
 * Fake AI: a batch call groups keywords by their first two words (so "оклейка авто" and
 * "оклейка машины" come back as different clusters, like a model that only sees one batch);
 * a merge call groups clusters whose main keyword is the same service after synonyms.
 */
function fakeLlm(opts: { failOn?: (content: string) => boolean; omit?: (q: string) => boolean } = {}) {
  const calls: { kind: 'batch' | 'merge'; content: string }[] = []
  const llm = async (messages: AiRouterMessage[]) => {
    const user = messages[1].content
    if (messages[0].content === MERGE_SYSTEM_PROMPT) {
      calls.push({ kind: 'merge', content: user })
      const byIntent = new Map<string, string[]>()
      for (const line of user.split('\n')) {
        const m = /^(\S+) \| \w+ \| .*? \| main: (.*?) \|/.exec(line)
        if (!m) continue
        const [service, car] = m[2].split(' ')
        const key = `${stem(service)} ${SYNONYMS[car] ?? car}`
        byIntent.set(key, [...(byIntent.get(key) ?? []), m[1]])
      }
      const groups = [...byIntent.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([key, ids]) => ({ ids, name: key, primaryKeyword: '', intent: 'commercial', recommendedPageUrl: null, confidence: 90, needsNewPage: true, excludeFromSeo: false, reason: 'merged' }))
      return JSON.stringify({ groups })
    }
    calls.push({ kind: 'batch', content: user })
    if (opts.failOn?.(user)) throw new Error('AI Router request failed (502)')
    const byTopic = new Map<string, string[]>()
    for (const q of promptKeywords(user)) {
      if (opts.omit?.(q)) continue
      const topic = q.split(' ').slice(0, 2).join(' ')
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), q])
    }
    return JSON.stringify({
      clusters: [...byTopic.entries()].map(([topic, keywords]) => ({
        name: topic, primaryKeyword: topic + ' вариант 0', keywords, intent: 'commercial', totalFrequency: 0,
        recommendedPageUrl: null, confidence: 80, needsNewPage: true, excludeFromSeo: false, reason: '',
      })),
    })
  }
  return { llm, calls }
}

async function withProject(t: TestContext, rows: { query: string; frequency: number }[], fn: (pool: Pool, projectId: number) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT 1 FROM seo_clusters LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres at DATABASE_URL — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_clustering__' || clock_timestamp()::text) RETURNING id`)).rows[0].id
  try {
    const projectId = (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url) VALUES ($1, 'p', $2, '') RETURNING id`, [
        clientId,
        `__test-${Date.now()}-${Math.random().toString(36).slice(2)}.example`,
      ])
    ).rows[0].id
    await pool.query(
      `INSERT INTO keywords (project_id, query, frequency, region) SELECT $1, q, f, '' FROM unnest($2::text[], $3::int[]) AS t(q, f)`,
      [projectId, rows.map((r) => r.query), rows.map((r) => r.frequency)],
    )
    await fn(pool, projectId)
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    await pool.end()
  }
}

async function savedClusters(pool: Pool, projectId: number) {
  const { rows } = await pool.query(
    `SELECT sc.id, sc.name, sc.review_status, sc.total_frequency, count(sck.id)::int AS n
     FROM seo_clusters sc LEFT JOIN seo_cluster_keywords sck ON sck.cluster_id = sc.id
     WHERE sc.project_id = $1 GROUP BY sc.id ORDER BY sc.id`,
    [projectId],
  )
  return rows as { id: number; name: string; review_status: string; total_frequency: number; n: number }[]
}

async function assertEveryKeywordOnce(pool: Pool, projectId: number) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS keywords,
            (SELECT count(*)::int FROM seo_cluster_keywords sck JOIN seo_clusters sc ON sc.id = sck.cluster_id WHERE sc.project_id = $1) AS links,
            (SELECT count(DISTINCT sck.keyword_id)::int FROM seo_cluster_keywords sck JOIN seo_clusters sc ON sc.id = sck.cluster_id WHERE sc.project_id = $1) AS distinct_links
     FROM keywords WHERE project_id = $1`,
    [projectId],
  )
  assert.equal(rows[0].links, rows[0].keywords, 'every keyword is in a cluster')
  assert.equal(rows[0].distinct_links, rows[0].keywords, 'no keyword is in two clusters')
}

test('5 250 keywords in 21 batches: one cluster per intent across batches, nothing lost', async (t) => {
  await withProject(t, dataset(), async (pool, projectId) => {
    const { llm, calls } = fakeLlm()
    const job = await generateClustersForProject(pool, projectId, { llm, batchSize: 250 })
    assert.equal(job.batches.length, 21)
    assert.equal(calls.filter((c) => c.kind === 'batch').length, 21)
    assert.ok(calls.filter((c) => c.kind === 'merge').length >= 1)
    // Same intent split across batches and across synonyms ("авто"/"автомобиля"/"машины") → ONE cluster each.
    const clusters = await savedClusters(pool, projectId)
    assert.equal(clusters.length, SERVICES.length)
    assert.ok(clusters.every((c) => c.n === 3 * 350))
    assert.deepEqual(job.result, { excludedByCleanup: 0, keywords: 5250, processed: 5250, clustersCreated: 5, addedToReviewed: 0, needsReviewKeywords: 0, llmCalls: job.llmCalls })
    const freq = (await pool.query('SELECT sum(frequency)::int AS f FROM keywords WHERE project_id = $1 AND query LIKE $2', [projectId, 'оклейка %'])).rows[0].f
    assert.equal(clusters.find((c) => c.name.startsWith('оклейк'))?.total_frequency, freq)
    await assertEveryKeywordOnce(pool, projectId)
  })
})

test('small merge chunks: several merge calls and passes still give one cluster per intent', async (t) => {
  await withProject(t, dataset(60), async (pool, projectId) => {
    const { llm, calls } = fakeLlm()
    await generateClustersForProject(pool, projectId, { llm, batchSize: 40, mergeChunkSize: 6 })
    assert.ok(calls.filter((c) => c.kind === 'merge').length > 1)
    assert.equal((await savedClusters(pool, projectId)).length, SERVICES.length)
    await assertEveryKeywordOnce(pool, projectId)
  })
})

test('a failing batch keeps finished batches and existing clusters; «Продолжить» redoes only that batch', async (t) => {
  await withProject(t, dataset(100), async (pool, projectId) => {
    await generateClustersForProject(pool, projectId, { llm: fakeLlm().llm, batchSize: 250 })
    const before = await savedClusters(pool, projectId)

    const broken = fakeLlm({ failOn: (c) => c.includes('химчистка') })
    const job = await runClusteringJob(pool, await createClusteringJob(pool, projectId, { batchSize: 250 }), { llm: broken.llm, batchSize: 250 })
    assert.equal(job.status, 'failed')
    assert.match(job.error!, /Продолжить/)
    const failed = job.batches.filter((b) => b.status === 'failed')
    assert.ok(failed.length >= 1 && job.batches.some((b) => b.status === 'done'))
    assert.deepEqual(await savedClusters(pool, projectId), before, 'DB untouched by a failed run')

    const healthy = fakeLlm()
    const resumed = await runClusteringJob(pool, job, { llm: healthy.llm, batchSize: 250 })
    assert.equal(resumed.status, 'done')
    assert.equal(healthy.calls.filter((c) => c.kind === 'batch').length, failed.length, 'finished batches are not re-sent')
    assert.equal((await savedClusters(pool, projectId)).length, SERVICES.length)
    await assertEveryKeywordOnce(pool, projectId)
  })
})

test('re-run: no duplicates; a human-reviewed cluster keeps its id and keywords and receives new ones', async (t) => {
  await withProject(t, dataset(40), async (pool, projectId) => {
    await generateClustersForProject(pool, projectId, { llm: fakeLlm().llm, batchSize: 50 })
    const first = await savedClusters(pool, projectId)
    const reviewed = first.find((c) => c.name.startsWith('оклейк'))!
    await pool.query(`UPDATE seo_clusters SET review_status = 'no_page', reviewed_at = now() WHERE id = $1`, [reviewed.id])
    await pool.query(`INSERT INTO keywords (project_id, query, frequency, region) VALUES ($1, 'оклейка машины вариант 999', 5, '')`, [projectId])

    const { llm, calls } = fakeLlm()
    const job = await generateClustersForProject(pool, projectId, { llm, batchSize: 50 })
    const second = await savedClusters(pool, projectId)
    assert.equal(second.length, SERVICES.length)
    const kept = second.find((c) => c.id === reviewed.id)!
    assert.equal(kept.review_status, 'no_page')
    assert.equal(kept.n, reviewed.n + 1)
    assert.equal(job.result?.addedToReviewed, 1)
    // The reviewed cluster's keywords were not sent to the AI again.
    assert.ok(calls.filter((c) => c.kind === 'batch').every((c) => !c.content.includes('оклейка авто вариант 1 ')))
    await assertEveryKeywordOnce(pool, projectId)
  })
})

test('keywords the AI leaves out get a second batch, then join their intent or become a "Needs review" cluster', async (t) => {
  await withProject(t, [...dataset(20), { query: 'непонятный запрос xyz', frequency: 3 }], async (pool, projectId) => {
    const lost = (q: string) => q === 'полировка авто вариант 7' || q === 'непонятный запрос xyz'
    const { llm, calls } = fakeLlm({ omit: lost })
    const job = await generateClustersForProject(pool, projectId, { llm, batchSize: 50 })
    assert.ok(job.batches.some((b) => b.orphan), 'a second-chance batch was sent')
    assert.ok(calls.some((c) => c.kind === 'batch' && promptKeywords(c.content).length === 2))
    const clusters = await savedClusters(pool, projectId)
    // The lost "полировка" keyword joins its intent cluster at merge; the odd one stays alone for review.
    assert.equal(clusters.length, SERVICES.length + 1)
    const single = clusters.find((c) => c.n === 1)!
    assert.equal(single.name, 'непонятный запрос xyz')
    assert.equal(job.result?.needsReviewKeywords, 1)
    const polish = (await pool.query(
      `SELECT count(*)::int AS n FROM seo_cluster_keywords sck JOIN keywords k ON k.id = sck.keyword_id
       WHERE k.project_id = $1 AND k.query = 'полировка авто вариант 7'
         AND sck.cluster_id = (SELECT sck2.cluster_id FROM seo_cluster_keywords sck2 JOIN keywords k2 ON k2.id = sck2.keyword_id
                               WHERE k2.project_id = $1 AND k2.query = 'полировка авто вариант 1')`,
      [projectId],
    )).rows[0].n
    assert.equal(polish, 1)
    await assertEveryKeywordOnce(pool, projectId)
  })
})

test('a batch too big for the AI to answer is halved automatically and the run still finishes', async (t) => {
  await withProject(t, dataset(60), async (pool, projectId) => {
    // Fake AI: any call with more than 130 keywords fails (like an answer cut off at the output limit).
    const { llm, calls } = fakeLlm({ failOn: (content) => promptKeywords(content).length > 130 })
    const job = await generateClustersForProject(pool, projectId, { llm, batchSize: 250 })
    assert.equal(job.status, 'done')
    assert.ok(job.batches.length > 4, 'big batches were replaced by halves')
    assert.ok(job.batches.every((b) => b.status === 'done' && b.keywordIds.length <= 130))
    assert.ok(calls.filter((c) => c.kind === 'batch').length > job.batches.length, 'the failed attempts were made')
    assert.equal((await savedClusters(pool, projectId)).length, SERVICES.length)
    await assertEveryKeywordOnce(pool, projectId)
  })
})

test('when even small batches fail the run stops with the reason visible, saved clusters untouched', async (t) => {
  await withProject(t, dataset(20), async (pool, projectId) => {
    await generateClustersForProject(pool, projectId, { llm: fakeLlm().llm, batchSize: 250 })
    const before = await savedClusters(pool, projectId)
    const { llm } = fakeLlm({ failOn: (content) => content.includes('тонировка') })
    const job = await runClusteringJob(pool, await createClusteringJob(pool, projectId, { batchSize: 250 }), { llm, batchSize: 250 })
    assert.equal(job.status, 'failed')
    const view = viewClusteringJob(job)
    assert.ok(view.failedBatches >= 1)
    assert.match(view.batchErrors.join(' '), /AI Router request failed \(502\)/)
    assert.deepEqual(await savedClusters(pool, projectId), before)
  })
})
