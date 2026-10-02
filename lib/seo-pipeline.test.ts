import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import type { AiRouterMessage } from './ai-router.ts'
import { cleanupKeywordsForProject, setKeywordRelevance } from './keywords-relevance.ts'
import { RELEVANCE_SYSTEM_PROMPT } from './keywords-relevance-rules.ts'
import { MERGE_SYSTEM_PROMPT } from './seo-clustering-batch.ts'
import { createClusterPipeline, clusterProject, runClusterPipeline } from './seo-pipeline.ts'

// The one «Кластеризовать» chain (cleanup → clustering) against a real Postgres with a fake AI
// Router; skipped without Postgres (migrations through 0012) at DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

const TARGET = ['оклейка авто цена', 'оклейка авто пленкой', 'оклейка geely monjaro']
const INFO = ['какой пленкой лучше оклеить автомобиль']
const EXCLUDED = ['защита ip68', 'оклейка авто владивосток']
const UNCERTAIN = ['оклейка авто такси']
const ALL = [...TARGET, ...INFO, ...EXCLUDED, ...UNCERTAIN]

function judge(q: string): { status: string; confidence: number; reason: string } {
  if (q.includes('владивосток')) return { status: 'geo_mismatch', confidence: 90, reason: 'Указан регион вне региона проекта' }
  if (q.includes('ip68')) return { status: 'irrelevant', confidence: 95, reason: 'Запрос не относится к бизнесу проекта' }
  if (q.startsWith('какой ')) return { status: 'informational', confidence: 85, reason: 'Информационный запрос по теме проекта' }
  if (q.includes('такси')) return { status: 'uncertain', confidence: 60, reason: 'Нужно решение: сегмент не подтверждён сайтом' }
  return { status: 'target', confidence: 92, reason: 'Основная услуга проекта' }
}

type Call = { kind: 'cleanup' | 'cluster' | 'merge'; queries: string[] }

function fakeAi(opts: { failCleanupOn?: (queries: string[]) => boolean; omitCleanup?: (q: string) => boolean } = {}) {
  const calls: Call[] = []
  const llm = async (messages: AiRouterMessage[]) => {
    const [system, user] = [messages[0].content, messages[1].content]
    if (system === RELEVANCE_SYSTEM_PROMPT) {
      const items = user.split('\n').filter((l) => /^\d+\t/.test(l)).map((l) => ({ id: Number(l.split('\t')[0]), q: l.split('\t')[1] }))
      calls.push({ kind: 'cleanup', queries: items.map((i) => i.q) })
      if (opts.failCleanupOn?.(items.map((i) => i.q))) throw new Error('AI Router request failed (502)')
      return JSON.stringify({
        results: items.filter((i) => !opts.omitCleanup?.(i.q)).map((i) => {
          const a = judge(i.q)
          return { keyword_id: i.id, relevance_status: a.status, confidence: a.confidence, reason: a.reason }
        }),
      })
    }
    if (system === MERGE_SYSTEM_PROMPT) {
      calls.push({ kind: 'merge', queries: [] })
      return JSON.stringify({ groups: [] })
    }
    const queries = user
      .split('\n')
      .map((l) => /^- (.*) \(frequency: -?\d+\)$/.exec(l)?.[1])
      .filter((q): q is string => Boolean(q))
    calls.push({ kind: 'cluster', queries })
    const byTopic = new Map<string, string[]>()
    for (const q of queries) byTopic.set(q.split(' ').slice(0, 2).join(' '), [...(byTopic.get(q.split(' ').slice(0, 2).join(' ')) ?? []), q])
    return JSON.stringify({
      clusters: [...byTopic.entries()].map(([topic, keywords]) => ({
        name: topic, primaryKeyword: keywords[0], keywords, intent: 'commercial', totalFrequency: 0,
        recommendedPageUrl: null, confidence: 80, needsNewPage: true, excludeFromSeo: false, reason: '',
      })),
    })
  }
  return { llm, calls, of: (kind: Call['kind']) => calls.filter((c) => c.kind === kind) }
}

async function withProject(t: TestContext, queries: string[], fn: (pool: Pool, projectId: number) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT relevance_status FROM keywords LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with migration 0012 at DATABASE_URL — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_pipeline__' || clock_timestamp()::text) RETURNING id`)).rows[0].id
  try {
    const projectId = (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url) VALUES ($1, 'Тестовый детейлинг', $2, '') RETURNING id`, [
        clientId,
        `__test-${Date.now()}-${Math.random().toString(36).slice(2)}.example`,
      ])
    ).rows[0].id
    await pool.query(`INSERT INTO keywords (project_id, query, frequency, region) SELECT $1, q, 100, '' FROM unnest($2::text[]) AS t(q)`, [projectId, queries])
    await fn(pool, projectId)
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    await pool.end()
  }
}

const clusteredQueries = async (pool: Pool, projectId: number) =>
  (
    await pool.query(
      `SELECT k.query FROM seo_cluster_keywords sck JOIN seo_clusters sc ON sc.id = sck.cluster_id JOIN keywords k ON k.id = sck.keyword_id
       WHERE sc.project_id = $1 ORDER BY k.query`,
      [projectId],
    )
  ).rows.map((r) => r.query as string)
const statusOf = async (pool: Pool, projectId: number, query: string) =>
  (await pool.query('SELECT relevance_status AS s, relevance_manual AS m FROM keywords WHERE project_id = $1 AND query = $2', [projectId, query])).rows[0]
const idOf = async (pool: Pool, projectId: number, query: string) =>
  (await pool.query('SELECT id FROM keywords WHERE project_id = $1 AND query = $2', [projectId, query])).rows[0].id as number

test('«Кластеризовать» with unclassified keywords: cleanup first, then clustering of target + informational only', async (t) => {
  await withProject(t, ALL, async (pool, projectId) => {
    const ai = fakeAi()
    const p = await clusterProject(pool, projectId, { llm: ai.llm })
    assert.equal(p.status, 'done')
    assert.ok(p.cleanup, 'cleanup ran')
    // Order: every cleanup call precedes every clustering call.
    const kinds = ai.calls.map((c) => c.kind)
    assert.ok(kinds.indexOf('cluster') > kinds.lastIndexOf('cleanup'), kinds.join(','))
    assert.deepEqual(await clusteredQueries(pool, projectId), [...TARGET, ...INFO].sort())
    for (const q of [...EXCLUDED, ...UNCERTAIN]) assert.equal((await clusteredQueries(pool, projectId)).includes(q), false, q)
    assert.equal(p.clustering?.result?.excludedByCleanup, 3)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM keywords WHERE project_id = $1', [projectId])).rows[0].n, ALL.length)
  })
})

test('uncertain does not block the chain: clustering runs, uncertain stays in «Требуют проверки» and the count is reported', async (t) => {
  await withProject(t, ALL, async (pool, projectId) => {
    const p = await clusterProject(pool, projectId, { llm: fakeAi().llm })
    assert.equal(p.status, 'done')
    assert.equal(p.uncertainLeft, 1)
    assert.equal(p.unclassifiedLeft, 0)
    assert.equal((await statusOf(pool, projectId, 'оклейка авто такси')).s, 'uncertain')
  })
})

test('no unclassified keywords: no cleanup AI call at all, straight to clustering', async (t) => {
  await withProject(t, ALL, async (pool, projectId) => {
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    const ai = fakeAi()
    const p = await clusterProject(pool, projectId, { llm: ai.llm })
    assert.equal(p.cleanup, null)
    assert.equal(ai.of('cleanup').length, 0)
    assert.ok(ai.of('cluster').length >= 1)
    assert.deepEqual(await clusteredQueries(pool, projectId), [...TARGET, ...INFO].sort())
  })
})

test('a failed cleanup batch stops the chain: no clustering, existing clusters untouched, resumable', async (t) => {
  await withProject(t, ALL, async (pool, projectId) => {
    // An existing cluster that must survive a run that fails during cleanup.
    const kw = await idOf(pool, projectId, 'оклейка авто цена')
    const old = (await pool.query(`INSERT INTO seo_clusters (project_id, name, primary_keyword_id) VALUES ($1, 'старый кластер', $2) RETURNING id`, [projectId, kw])).rows[0].id
    await pool.query('INSERT INTO seo_cluster_keywords (cluster_id, keyword_id) VALUES ($1, $2)', [old, kw])

    const ai = fakeAi({ failCleanupOn: (qs) => qs.includes('защита ip68') })
    const p = await runClusterPipeline(pool, await createClusterPipeline(pool, projectId, { relevanceBatchSize: 2 }), { llm: ai.llm, relevanceBatchSize: 2, concurrency: 1 })
    assert.equal(p.status, 'failed')
    assert.equal(p.failedIn, 'cleanup')
    assert.equal(p.resumable, true)
    assert.match(p.error!, /Продолжить/)
    assert.equal(ai.of('cluster').length, 0, 'clustering never started')
    assert.equal(p.clustering, null)
    assert.deepEqual(await clusteredQueries(pool, projectId), ['оклейка авто цена'])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM seo_clusters WHERE id = $1', [old])).rows[0].n, 1)
    // Finished cleanup batches are saved.
    assert.ok((await pool.query('SELECT count(*)::int AS n FROM keywords WHERE project_id = $1 AND relevance_status IS NOT NULL', [projectId])).rows[0].n > 0)
  })
})

test('resume after a failed cleanup: only the failed batch is re-sent, then clustering runs', async (t) => {
  await withProject(t, ALL, async (pool, projectId) => {
    const first = fakeAi({ failCleanupOn: (qs) => qs.includes('защита ip68') })
    const p = await runClusterPipeline(pool, await createClusterPipeline(pool, projectId, { relevanceBatchSize: 2 }), { llm: first.llm, relevanceBatchSize: 2, concurrency: 1 })
    assert.equal(p.status, 'failed')
    const failedBatches = p.cleanup!.batches.filter((b) => b.status === 'failed').length
    assert.equal(failedBatches, 1)

    const second = fakeAi()
    await runClusterPipeline(pool, p, { llm: second.llm, relevanceBatchSize: 2, concurrency: 1 })
    assert.equal(p.status, 'done')
    assert.equal(second.of('cleanup').length, failedBatches, 'only the failed batch is re-sent')
    assert.ok(second.of('cluster').length >= 1, 'clustering ran after the resume')
    assert.deepEqual(await clusteredQueries(pool, projectId), [...TARGET, ...INFO].sort())
  })
})

test('manual overrides survive the automatic chain and drive clustering', async (t) => {
  await withProject(t, ALL, async (pool, projectId) => {
    await setKeywordRelevance(pool, { projectId, keywordId: await idOf(pool, projectId, 'оклейка авто такси'), status: 'target' })
    await setKeywordRelevance(pool, { projectId, keywordId: await idOf(pool, projectId, 'оклейка авто пленкой'), status: 'irrelevant' })
    const ai = fakeAi()
    const p = await clusterProject(pool, projectId, { llm: ai.llm })
    assert.equal(p.status, 'done')
    const sent = ai.of('cleanup').flatMap((c) => c.queries)
    assert.equal(sent.includes('оклейка авто такси'), false)
    assert.equal(sent.includes('оклейка авто пленкой'), false)
    assert.deepEqual(await statusOf(pool, projectId, 'оклейка авто такси'), { s: 'target', m: true })
    assert.deepEqual(await statusOf(pool, projectId, 'оклейка авто пленкой'), { s: 'irrelevant', m: true })
    const clustered = await clusteredQueries(pool, projectId)
    assert.equal(clustered.includes('оклейка авто такси'), true)
    assert.equal(clustered.includes('оклейка авто пленкой'), false)
  })
})

test('queries the AI skipped do not block clustering; they stay unchecked and are reported', async (t) => {
  await withProject(t, ALL, async (pool, projectId) => {
    const p = await clusterProject(pool, projectId, { llm: fakeAi({ omitCleanup: (q) => q === 'оклейка geely monjaro' }).llm })
    assert.equal(p.status, 'done')
    assert.equal(p.unclassifiedLeft, 1)
    assert.equal((await statusOf(pool, projectId, 'оклейка geely monjaro')).s, null)
    assert.equal((await clusteredQueries(pool, projectId)).includes('оклейка geely monjaro'), false)
  })
})

test('nothing eligible after cleanup: a clear, non-resumable stop instead of an error', async (t) => {
  await withProject(t, ['защита ip68', 'оклейка авто владивосток'], async (pool, projectId) => {
    const p = await runClusterPipeline(pool, await createClusterPipeline(pool, projectId), { llm: fakeAi().llm })
    assert.equal(p.status, 'failed')
    assert.equal(p.failedIn, 'clustering')
    assert.equal(p.resumable, false)
    assert.match(p.error!, /Нет запросов для кластеризации/)
  })
})
