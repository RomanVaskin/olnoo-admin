import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import type { AiRouterMessage } from './ai-router.ts'
import {
  buildClusterReviewUserPrompt,
  CLUSTER_REVIEW_SYSTEM_PROMPT,
  parseClusterReviewResponse,
  runClusterReview,
  sanitizeSlug,
  waitForClusterReview,
  type ClusterReviewJob,
} from './seo-cluster-review.ts'
import { listClustersForProject } from './seo-clustering.ts'
import { saveProjectSeoContext } from './project-seo-context.ts'

// DB integration tests for «AI проверить все кластеры» with a fake model; skipped without Postgres
// (migrations through 0014 applied) at DATABASE_URL. Clusters are seeded directly, clustering is not run.
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

type Seed = { name: string; keywords: [string, number][]; reviewStatus?: string }

type Ctx = { pool: Pool; projectId: number; clusterIds: Record<string, number>; pageIds: Record<string, number> }

async function withClusters(t: TestContext, seeds: Seed[], fn: (c: Ctx) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT ai_decision FROM seo_clusters LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with migration 0014 at DATABASE_URL — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_cluster_review__' || clock_timestamp()::text) RETURNING id`)).rows[0].id
  try {
    const projectId = (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url) VALUES ($1, 'Тестовый проект', $2, '') RETURNING id`, [
        clientId,
        `__test-${Date.now()}-${Math.random().toString(36).slice(2)}.example`,
      ])
    ).rows[0].id
    const pageIds: Record<string, number> = {}
    for (const [key, path, title, h1] of [
      ['wrap', '/okleyka', 'Оклейка авто', 'Оклейка авто пленкой'],
      ['ppf', '/ppf', 'Антигравийная пленка', 'Антигравийная защита'],
      ['about', '/about', 'О компании', 'О нас'],
    ]) {
      pageIds[key] = (await pool.query(`INSERT INTO pages (project_id, url, title, h1) VALUES ($1, $2, $3, $4) RETURNING id`, [projectId, `https://x.example${path}`, title, h1])).rows[0].id
    }
    const clusterIds: Record<string, number> = {}
    for (const s of seeds) {
      const total = s.keywords.reduce((n, [, f]) => n + f, 0)
      const id = (
        await pool.query(
          `INSERT INTO seo_clusters (project_id, name, intent, total_frequency, status, review_status) VALUES ($1, $2, 'commercial', $3, 'Needs review', $4) RETURNING id`,
          [projectId, s.name, total, s.reviewStatus ?? 'pending'],
        )
      ).rows[0].id
      clusterIds[s.name] = id
      for (const [q, f] of s.keywords) {
        const kid = (await pool.query(`INSERT INTO keywords (project_id, query, frequency, region) VALUES ($1, $2, $3, '') RETURNING id`, [projectId, q, f])).rows[0].id
        await pool.query(`INSERT INTO seo_cluster_keywords (cluster_id, keyword_id) VALUES ($1, $2)`, [id, kid])
      }
    }
    await fn({ pool, projectId, clusterIds, pageIds })
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    await pool.end()
  }
}

const SEEDS: Seed[] = [
  { name: 'Антигравийная пленка', keywords: [['антигравийная пленка цена', 500], ['бронепленка на авто', 300]] },
  { name: 'Детейлинг салона', keywords: [['химчистка салона авто', 400], ['детейлинг салона цена', 200]] },
  { name: 'Конкурент Икс', keywords: [['икс автосервис', 90]] },
]

/** Fake model: answers with the compact JSON for the cluster ids it finds in the prompt. */
function fakeModel(answer: (id: number, name: string) => unknown[] | null, hooks: { before?: () => Promise<void> } = {}) {
  const prompts: string[] = []
  const llm = async (messages: AiRouterMessage[]) => {
    assert.equal(messages[0].content, CLUSTER_REVIEW_SYSTEM_PROMPT)
    prompts.push(messages[1].content)
    await hooks.before?.()
    const rows = [...messages[1].content.matchAll(/^\[(\d+)\] (.+?) \|/gm)].map((m) => answer(Number(m[1]), m[2])).filter((r): r is unknown[] => r !== null)
    return JSON.stringify({ d: rows })
  }
  return { llm, prompts }
}

const decide = (ids: Record<string, number>, pages: Record<string, number>) => (id: number, name: string): unknown[] | null => {
  void pages
  if (id === ids['Антигравийная пленка']) return [id, 'I', 'https://x.example/ppf', 'Тема уже покрыта страницей']
  if (id === ids['Детейлинг салона']) return [id, 'C', '/Detejling Salona/', 'Детейлинг салона авто', 'Детейлинг салона авто — цены и услуги', 'Отдельный интент без страницы']
  if (id === ids['Конкурент Икс']) return [id, 'X', 'Навигационный запрос чужого бренда']
  return null
}

const rowOf = async (pool: Pool, id: number) =>
  (await pool.query(`SELECT status, review_status, ai_decision, recommended_page_id, needs_new_page, reason, suggested_slug, suggested_h1, suggested_title FROM seo_clusters WHERE id = $1`, [id])).rows[0]

const run = async (pool: Pool, projectId: number, opts: Parameters<typeof runClusterReview>[2]): Promise<ClusterReviewJob> =>
  waitForClusterReview(await runClusterReview(pool, projectId, opts))

test('CREATE / IMPROVE / IGNORE decisions are saved in the AI layer; CREATE gets slug, H1 and Title, IMPROVE the exact page', async (t) => {
  await withClusters(t, SEEDS, async ({ pool, projectId, clusterIds, pageIds }) => {
    const model = fakeModel(decide(clusterIds, pageIds))
    const job = await run(pool, projectId, { llm: model.llm })
    assert.equal(job.status, 'done')
    assert.deepEqual(job.counts, { create: 1, improve: 1, ignore: 1 })

    const improve = await rowOf(pool, clusterIds['Антигравийная пленка'])
    assert.equal(improve.ai_decision, 'improve')
    assert.equal(improve.status, 'Existing page')
    assert.equal(improve.recommended_page_id, pageIds.ppf)
    assert.equal(improve.needs_new_page, false)

    const create = await rowOf(pool, clusterIds['Детейлинг салона'])
    assert.equal(create.ai_decision, 'create')
    assert.equal(create.status, 'No page')
    assert.equal(create.needs_new_page, true)
    assert.equal(create.recommended_page_id, null)
    assert.equal(create.suggested_slug, 'detejling-salona')
    assert.equal(create.suggested_h1, 'Детейлинг салона авто')
    assert.match(create.suggested_title, /цены/)

    const ignore = await rowOf(pool, clusterIds['Конкурент Икс'])
    assert.equal(ignore.ai_decision, 'ignore')
    assert.equal(ignore.status, 'Ignored')
    assert.match(ignore.reason, /бренда/)

    // Only the AI layer: no human review was recorded, and the list API exposes the suggestions.
    for (const id of Object.values(clusterIds)) assert.equal((await rowOf(pool, id)).review_status, 'pending')
    const listed = (await listClustersForProject(pool, projectId)).find((c) => c.id === clusterIds['Детейлинг салона'])!
    assert.equal(listed.aiDecision, 'create')
    assert.equal(listed.suggestedSlug, 'detejling-salona')
  })
})

test('the prompt carries the whole cluster, the SEO context and the existing pages', async (t) => {
  await withClusters(t, SEEDS, async ({ pool, projectId, clusterIds, pageIds }) => {
    await saveProjectSeoContext(pool, projectId, { businessType: 'Студия детейлинга', region: 'Москва', services: 'Оклейка авто\nАнтигравийная пленка', plannedServices: '', excluded: '' })
    const model = fakeModel(decide(clusterIds, pageIds))
    await run(pool, projectId, { llm: model.llm })
    const prompt = model.prompts.join('\n')
    assert.match(prompt, /бронепленка на авто/) // not only the representative keyword
    assert.match(prompt, /детейлинг салона цена/)
    assert.match(prompt, /Студия детейлинга/)
    assert.match(prompt, /https:\/\/x\.example\/ppf \| title: Антигравийная пленка/)
  })
})

test('production default routes through SEO_BULK_ROUTE: deepseek, reasoningMode off, no fallback', async (t) => {
  await withClusters(t, SEEDS, async ({ pool, projectId, clusterIds, pageIds }) => {
    const original = globalThis.fetch
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      const messages = body.messages as AiRouterMessage[]
      const rows = [...messages[1].content.matchAll(/^\[(\d+)\] (.+?) \|/gm)].map((m) => decide(clusterIds, pageIds)(Number(m[1]), m[2])).filter(Boolean)
      return new Response(JSON.stringify({ provider: body.provider, model: 'deepseek-v4-flash', content: JSON.stringify({ d: rows }), fallbackUsed: false }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const job = await run(pool, projectId, {})
      assert.equal(job.status, 'done')
    } finally {
      globalThis.fetch = original
    }
    assert.ok(bodies.length >= 1)
    for (const b of bodies) {
      assert.equal(b.provider, 'deepseek')
      assert.equal(b.allowFallback, false)
      assert.equal(b.reasoningMode, 'off')
      assert.deepEqual(b.metadata, { application: 'olnoo-admin', task: 'seo-cluster-review' })
    }
  })
})

test('manual decisions are never overwritten: reviewed clusters are skipped and a decision made during the run wins', async (t) => {
  const seeds: Seed[] = [...SEEDS, { name: 'Уже решено', keywords: [['ручной кластер', 10]], reviewStatus: 'confirmed' }]
  await withClusters(t, seeds, async ({ pool, projectId, clusterIds, pageIds }) => {
    await pool.query(`UPDATE seo_clusters SET confirmed_page_id = $2, status = 'Existing page' WHERE id = $1`, [clusterIds['Уже решено'], pageIds.wrap])
    const model = fakeModel((id, name) => decide(clusterIds, pageIds)(id, name) ?? [id, 'X', 'не должно записаться'], {
      // The user rejects a cluster by hand while the batch is in flight.
      before: () => pool.query(`UPDATE seo_clusters SET review_status = 'no_page' WHERE id = $1`, [clusterIds['Детейлинг салона']]).then(() => undefined),
    })
    const job = await run(pool, projectId, { llm: model.llm })
    assert.equal(job.status, 'done')
    assert.ok(!model.prompts.join('\n').includes('ручной кластер'), 'a human-reviewed cluster is not even sent to the AI')

    const confirmed = await rowOf(pool, clusterIds['Уже решено'])
    assert.equal(confirmed.ai_decision, null)
    assert.equal(confirmed.review_status, 'confirmed')
    const mid = await rowOf(pool, clusterIds['Детейлинг салона'])
    assert.equal(mid.review_status, 'no_page')
    assert.equal(mid.ai_decision, null)
    assert.equal(mid.suggested_slug, null)
    assert.equal(job.reviewed, 2)
  })
})

test('a failed batch keeps finished decisions; running again continues with the rest only', async (t) => {
  await withClusters(t, SEEDS, async ({ pool, projectId, clusterIds, pageIds }) => {
    let failName = 'Детейлинг салона'
    const first = fakeModel(decide(clusterIds, pageIds))
    const llm = async (messages: AiRouterMessage[]) => {
      if (failName && messages[1].content.includes(`] ${failName} |`)) throw new Error('AI Router request failed (502)')
      return first.llm(messages)
    }
    const job1 = await run(pool, projectId, { llm, batchSize: 1, concurrency: 1 })
    assert.equal(job1.status, 'failed')
    assert.equal(job1.batchesFailed, 1)
    assert.equal(job1.reviewed, 2)
    assert.equal((await rowOf(pool, clusterIds['Антигравийная пленка'])).ai_decision, 'improve')
    assert.equal((await rowOf(pool, clusterIds['Детейлинг салона'])).ai_decision, null)

    failName = ''
    const second = fakeModel(decide(clusterIds, pageIds))
    const job2 = await run(pool, projectId, { llm: second.llm, batchSize: 1, concurrency: 1 })
    assert.equal(job2.status, 'done')
    assert.equal(job2.total, 1, 'only the undecided cluster is re-sent')
    assert.equal((await rowOf(pool, clusterIds['Детейлинг салона'])).ai_decision, 'create')
  })
})

test('invalid answers leave the cluster undecided: unknown page, utility page, CREATE without H1/Title', async (t) => {
  await withClusters(t, SEEDS, async ({ pool, projectId, clusterIds }) => {
    const model = fakeModel((id) => {
      if (id === clusterIds['Антигравийная пленка']) return [id, 'I', 'https://x.example/nope', 'нет такой страницы']
      if (id === clusterIds['Детейлинг салона']) return [id, 'C', 'detejling', '', '', 'без H1']
      return [id, 'I', 'https://x.example/about', 'about как заглушка']
    })
    const job = await run(pool, projectId, { llm: model.llm })
    assert.equal(job.status, 'done')
    assert.equal(job.reviewed, 0)
    assert.equal(job.skipped, 3)
    for (const id of Object.values(clusterIds)) assert.equal((await rowOf(pool, id)).ai_decision, null)
  })
})

test('parse / prompt helpers: slug sanitising, one decision per id, unparseable answer throws, large cluster is capped', () => {
  assert.equal(sanitizeSlug('https://x.example/Okleyka Avto/'), 'okleyka-avto')
  const pages = [{ id: 7, url: 'https://x.example/ppf', title: null, h1: null }]
  const out = parseClusterReviewResponse(JSON.stringify({ d: [[1, 'X', 'a'], [1, 'X', 'b'], [2, 'I', '/ppf', 'r'], [99, 'X', 'unknown id']] }), new Set([1, 2]), pages)
  assert.deepEqual(out.map((d) => [d.id, d.decision]), [[1, 'ignore'], [2, 'improve']])
  assert.throws(() => parseClusterReviewResponse('не json', new Set([1]), pages))
  const keywords = Array.from({ length: 40 }, (_, i) => ({ query: `запрос ${i}`, frequency: i }))
  const prompt = buildClusterReviewUserPrompt('CTX', [{ id: 1, name: 'n', intent: 'commercial', totalFrequency: 5, keywords }])
  assert.match(prompt, /keywords \(40\)/)
  assert.match(prompt, /\+25 more/)
})

test('force re-decides pending clusters that already have an AI decision (with the current pages); human-reviewed ones stay untouched', async (t) => {
  const seeds: Seed[] = [...SEEDS, { name: 'Уже решено', keywords: [['ручной кластер', 10]], reviewStatus: 'confirmed' }]
  await withClusters(t, seeds, async ({ pool, projectId, clusterIds, pageIds }) => {
    const first = fakeModel(decide(clusterIds, pageIds))
    await run(pool, projectId, { llm: first.llm })
    assert.equal((await rowOf(pool, clusterIds['Детейлинг салона'])).ai_decision, 'create')

    // A page for the "create" cluster appears (Pages sync); the manual cluster is already confirmed.
    const detailing = (await pool.query(`INSERT INTO pages (project_id, url, title, h1) VALUES ($1, 'https://x.example/detejling', 'Детейлинг', 'Детейлинг салона') RETURNING id`, [projectId])).rows[0].id
    const confirmedBefore = await rowOf(pool, clusterIds['Уже решено'])

    const plain = fakeModel(decide(clusterIds, pageIds))
    const skipped = await run(pool, projectId, { llm: plain.llm })
    assert.equal(skipped.total, 0, 'without force nothing is re-sent')
    assert.equal(plain.prompts.length, 0)

    const second = fakeModel((id, name) =>
      id === clusterIds['Детейлинг салона'] ? [id, 'I', 'https://x.example/detejling', 'Теперь есть страница'] : decide(clusterIds, pageIds)(id, name),
    )
    const job = await run(pool, projectId, { llm: second.llm, force: true })
    assert.equal(job.status, 'done')
    assert.equal(job.total, 3, 'all pending clusters are re-sent, the confirmed one is not')
    assert.match(second.prompts.join('\n'), /https:\/\/x\.example\/detejling \| title: Детейлинг/, 'the prompt carries the current pages')
    assert.ok(!second.prompts.join('\n').includes('ручной кластер'))

    const redone = await rowOf(pool, clusterIds['Детейлинг салона'])
    assert.equal(redone.ai_decision, 'improve')
    assert.equal(redone.recommended_page_id, detailing)
    assert.equal(redone.needs_new_page, false)
    assert.equal(redone.suggested_slug, null, 'the old CREATE suggestion is cleared')
    assert.deepEqual(await rowOf(pool, clusterIds['Уже решено']), confirmedBefore)
  })
})
