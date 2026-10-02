import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import type { AiRouterMessage } from './ai-router.ts'
import { importKeywordFiles } from './keywords-import.ts'
import {
  cleanupKeywordsForProject,
  createRelevanceJob,
  getRelevanceSummary,
  listKeywordRelevance,
  requeueAllAiDecisions,
  RelevanceError,
  runRelevanceJob,
  setKeywordRelevance,
} from './keywords-relevance.ts'
import { RELEVANCE_SYSTEM_PROMPT, type RelevanceStatus } from './keywords-relevance-rules.ts'
import { saveProjectSeoContext, getProjectSeoContext, SeoContextError } from './project-seo-context.ts'
import { createClusteringJob } from './seo-clustering.ts'

// DB integration tests for AI relevance cleanup with a fake AI Router; skipped without Postgres
// (migrations through 0012 applied) at DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

type Answer = { status: RelevanceStatus; confidence: number; reason: string }

/** Fake AI keyed on the query text, like the examples of the task. */
function judge(query: string): Answer {
  if (query.includes('владивосток')) return { status: 'geo_mismatch', confidence: 90, reason: 'Указан регион вне региона проекта' }
  if (query.includes('ip68') || query.includes('протечек')) return { status: 'irrelevant', confidence: 95, reason: 'Запрос не относится к бизнесу проекта' }
  if (query.startsWith('какой ') || query.startsWith('как ')) return { status: 'informational', confidence: 85, reason: 'Информационный запрос по теме проекта' }
  if (query.includes('фургон') || query.includes('такси')) return { status: 'uncertain', confidence: 60, reason: 'Нужно решение: сегмент не подтверждён сайтом' }
  if (query.includes('сомнение')) return { status: 'irrelevant', confidence: 40, reason: 'Запрос не относится к бизнесу проекта' }
  return { status: 'target', confidence: 92, reason: 'Основная услуга проекта' }
}

function fakeAi(
  opts: {
    failOn?: (queries: string[]) => boolean
    malformedOn?: (queries: string[]) => boolean
    omit?: (q: string) => boolean
    judge?: (q: string, prompt: string) => Answer | undefined
  } = {},
) {
  const calls: { queries: string[]; prompt: string }[] = []
  const llm = async (messages: AiRouterMessage[]) => {
    assert.equal(messages[0].content, RELEVANCE_SYSTEM_PROMPT)
    const lines = messages[1].content.split('\n').filter((l) => /^\d+\t/.test(l))
    const items = lines.map((l) => ({ id: Number(l.split('\t')[0]), query: l.split('\t')[1] }))
    const queries = items.map((i) => i.query)
    calls.push({ queries, prompt: messages[1].content })
    if (opts.failOn?.(queries)) throw new Error('AI Router request failed (502)')
    if (opts.malformedOn?.(queries)) return 'Конечно! Вот результат: ...'
    return JSON.stringify({
      results: items
        .filter((i) => !opts.omit?.(i.query))
        .map((i) => {
          const a = opts.judge?.(i.query, messages[1].content) ?? judge(i.query)
          return { keyword_id: i.id, relevance_status: a.status, confidence: a.confidence, reason: a.reason }
        }),
    })
  }
  return { llm, calls }
}

async function withProject(t: TestContext, queries: string[], fn: (pool: Pool, projectId: number) => Promise<void>, opts: { pages?: boolean } = {}) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT relevance_status FROM keywords LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with migration 0012 at DATABASE_URL — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_relevance__' || clock_timestamp()::text) RETURNING id`)).rows[0].id
  try {
    const projectId = (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url) VALUES ($1, 'Тестовый детейлинг', $2, '') RETURNING id`, [
        clientId,
        `__test-${Date.now()}-${Math.random().toString(36).slice(2)}.example`,
      ])
    ).rows[0].id
    if (opts.pages !== false) {
      await pool.query(`INSERT INTO pages (project_id, url, title, h1) VALUES ($1, 'https://x.example/okleyka', 'Оклейка авто в Москве', 'Оклейка авто')`, [projectId])
    }
    if (queries.length) {
      await pool.query(
        `INSERT INTO keywords (project_id, query, frequency, region) SELECT $1, q, 100, '' FROM unnest($2::text[]) AS t(q)`,
        [projectId, queries],
      )
    }
    await fn(pool, projectId)
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    await pool.end()
  }
}

const SAMPLE = [
  'оклейка авто цена', // target
  'какой пленкой лучше оклеить автомобиль', // informational
  'защита ip68', // irrelevant
  'оклейка авто владивосток', // geo_mismatch
  'оклейка авто такси', // uncertain
  'оклейка авто сомнение', // AI says irrelevant @40 → threshold → uncertain
]

const statusOf = async (pool: Pool, projectId: number, query: string) =>
  (await pool.query('SELECT relevance_status AS s, relevance_confidence AS c, relevance_reason AS r, relevance_manual AS m FROM keywords WHERE project_id = $1 AND query = $2', [projectId, query])).rows[0]
const countKeywords = async (pool: Pool, projectId: number) => (await pool.query('SELECT count(*)::int AS n FROM keywords WHERE project_id = $1', [projectId])).rows[0].n as number
const clusteredQueries = async (projectId: number, pool: Pool) => [...(await createClusteringJob(pool, projectId)).keywords.values()].map((k) => k.query).sort()

test('classification of target / informational / irrelevant / geo_mismatch / uncertain is saved with confidence and a Russian reason', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    const { llm } = fakeAi()
    const job = await cleanupKeywordsForProject(pool, projectId, { llm })
    assert.equal(job.result?.checked, 6)
    const expected: [string, RelevanceStatus][] = [
      ['оклейка авто цена', 'target'],
      ['какой пленкой лучше оклеить автомобиль', 'informational'],
      ['защита ip68', 'irrelevant'],
      ['оклейка авто владивосток', 'geo_mismatch'],
      ['оклейка авто такси', 'uncertain'],
    ]
    for (const [query, status] of expected) {
      const row = await statusOf(pool, projectId, query)
      assert.equal(row.s, status, query)
      assert.ok(row.c >= 0 && row.c <= 100)
      assert.match(row.r, /[А-Яа-я]/)
      assert.ok(row.r.length <= 160)
      assert.equal(row.m, false)
    }
    // Low confidence: AI said irrelevant@40 (threshold 70) → persisted as uncertain.
    const low = await statusOf(pool, projectId, 'оклейка авто сомнение')
    assert.equal(low.s, 'uncertain')
    assert.equal(low.c, 40)
    assert.match(low.r, /^Низкая уверенность AI \(40%\)/)
    assert.equal(job.result?.downgraded, 1)
  })
})

test('unclassified (NULL) and uncertain are different states', async (t) => {
  await withProject(t, ['оклейка авто такси', 'оклейка авто цена'], async (pool, projectId) => {
    assert.deepEqual(await statusOf(pool, projectId, 'оклейка авто такси'), { s: null, c: null, r: null, m: false })
    let summary = await getRelevanceSummary(pool, projectId)
    assert.deepEqual({ u: summary.unclassified, c: summary.uncertain, uses: summary.usesCleanup }, { u: 2, c: 0, uses: false })
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    summary = await getRelevanceSummary(pool, projectId)
    assert.deepEqual({ u: summary.unclassified, c: summary.uncertain, t: summary.target, uses: summary.usesCleanup }, { u: 0, c: 1, t: 1, uses: true })
  })
})

test('a malformed AI answer fails that batch, saves nothing and is retryable', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    const bad = fakeAi({ malformedOn: () => true })
    const job = await runRelevanceJob(pool, await createRelevanceJob(pool, projectId, { batchSize: 100 }), { llm: bad.llm })
    assert.equal(job.status, 'failed')
    assert.equal(job.batches[0].status, 'failed')
    assert.match(job.error!, /Продолжить/)
    assert.equal(bad.calls.length, 2, 'one retry')
    assert.equal((await getRelevanceSummary(pool, projectId)).unclassified, 6)
    assert.equal((await getRelevanceSummary(pool, projectId)).usesCleanup, false, 'nothing saved → the project did not start using cleanup')
    const ok = await runRelevanceJob(pool, job, { llm: fakeAi().llm, batchSize: 100 })
    assert.equal(ok.status, 'done')
  })
})

test('partial failure keeps saved batches; resume sends only the failed batch', async (t) => {
  const queries = Array.from({ length: 10 }, (_, i) => `оклейка авто вариант ${i}`)
  await withProject(t, queries, async (pool, projectId) => {
    const first = fakeAi({ failOn: (q) => q.includes('оклейка авто вариант 7') })
    const job = await runRelevanceJob(pool, await createRelevanceJob(pool, projectId, { batchSize: 2 }), { llm: first.llm, batchSize: 2, concurrency: 1 })
    assert.equal(job.status, 'failed')
    const failed = job.batches.filter((b) => b.status === 'failed')
    assert.equal(failed.length, 1)
    assert.equal(job.batches.filter((b) => b.status === 'done').length, 4)
    const afterFailure = await getRelevanceSummary(pool, projectId)
    assert.equal(afterFailure.target, 8, 'finished batches are saved')
    assert.equal(afterFailure.unclassified, 2)
    assert.equal(afterFailure.usesCleanup, true)

    const second = fakeAi()
    const done = await runRelevanceJob(pool, job, { llm: second.llm, batchSize: 2, concurrency: 1 })
    assert.equal(done.status, 'done')
    assert.equal(second.calls.length, 1, 'only the failed batch is re-sent')
    assert.equal((await getRelevanceSummary(pool, projectId)).unclassified, 0)
  })
})

test('manual override is saved, never sent to the AI again and never overwritten by ordinary cleanup', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    const id = (await pool.query(`SELECT id FROM keywords WHERE project_id = $1 AND query = 'оклейка авто такси'`, [projectId])).rows[0].id
    await setKeywordRelevance(pool, { projectId, keywordId: id, status: 'target' })
    assert.deepEqual(await statusOf(pool, projectId, 'оклейка авто такси'), { s: 'target', c: null, r: 'Решение пользователя', m: true })

    // A new keyword makes a run necessary; the manual one must not be in it.
    await pool.query(`INSERT INTO keywords (project_id, query, frequency, region) VALUES ($1, 'оклейка авто новая', 1, '')`, [projectId])
    const ai = fakeAi()
    await cleanupKeywordsForProject(pool, projectId, { llm: ai.llm })
    assert.equal(ai.calls.flatMap((c) => c.queries).includes('оклейка авто такси'), false)
    assert.equal((await statusOf(pool, projectId, 'оклейка авто такси')).s, 'target')

    // Even if a run is already in flight, the guarded UPDATE leaves a manual row alone.
    const job = await createRelevanceJob(pool, projectId, { reviewManual: true })
    await pool.query(`INSERT INTO keywords (project_id, query, frequency, region) VALUES ($1, 'оклейка авто гонка', 1, '')`, [projectId])
    const racing = await createRelevanceJob(pool, projectId)
    await pool.query(`UPDATE keywords SET relevance_status = 'irrelevant', relevance_manual = true WHERE project_id = $1 AND query = 'оклейка авто гонка'`, [projectId])
    await runRelevanceJob(pool, racing, { llm: fakeAi().llm })
    assert.equal((await statusOf(pool, projectId, 'оклейка авто гонка')).s, 'irrelevant')
    assert.equal((await statusOf(pool, projectId, 'оклейка авто гонка')).m, true)

    // Explicit "review manually changed" re-sends them and clears the flag.
    const review = fakeAi()
    await runRelevanceJob(pool, job, { llm: review.llm, reviewManual: true })
    assert.ok(review.calls.flatMap((c) => c.queries).includes('оклейка авто такси'))
    assert.equal((await statusOf(pool, projectId, 'оклейка авто такси')).m, false)
  })
})

test('5 300 keywords: cleaned in batches of 100, every keyword classified once, none deleted', async (t) => {
  const queries = Array.from({ length: 5300 }, (_, i) => `оклейка авто вариант ${i}`)
  await withProject(t, queries, async (pool, projectId) => {
    const ai = fakeAi()
    const job = await cleanupKeywordsForProject(pool, projectId, { llm: ai.llm })
    assert.equal(job.batches.length, 53)
    assert.equal(ai.calls.length, 53)
    assert.ok(ai.calls.every((c) => c.queries.length <= 100))
    assert.equal(ai.calls.flatMap((c) => c.queries).length, 5300, 'no keyword sent twice in one run')
    const summary = await getRelevanceSummary(pool, projectId)
    assert.deepEqual({ total: summary.total, target: summary.target, unclassified: summary.unclassified }, { total: 5300, target: 5300, unclassified: 0 })
    assert.equal(await countKeywords(pool, projectId), 5300)
  })
})

test('cleanup deletes neither keywords nor existing clusters', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    const kwId = (await pool.query(`SELECT id FROM keywords WHERE project_id = $1 LIMIT 1`, [projectId])).rows[0].id
    const cluster = (await pool.query(`INSERT INTO seo_clusters (project_id, name, primary_keyword_id) VALUES ($1, 'старый кластер', $2) RETURNING id`, [projectId, kwId])).rows[0].id
    await pool.query('INSERT INTO seo_cluster_keywords (cluster_id, keyword_id) VALUES ($1, $2)', [cluster, kwId])
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    assert.equal(await countKeywords(pool, projectId), 6)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM seo_clusters WHERE project_id = $1', [projectId])).rows[0].n, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM seo_cluster_keywords WHERE cluster_id = $1', [cluster])).rows[0].n, 1)
  })
})

test('new imports stay unclassified; the next cleanup sends only them; a frequency update keeps the classification; nothing new = no AI calls', async (t) => {
  await withProject(t, [], async (pool, projectId) => {
    await importKeywordFiles(pool, projectId, [{ fileName: 'a.csv', rows: ['оклейка авто цена', 'защита ip68', 'как наклеить бронепленку'].map((keyword) => ({ keyword, frequency: 100, region: '' })) }])
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    const before = await statusOf(pool, projectId, 'защита ip68')

    // Second Wordstat import: one frequency update of an existing keyword + two new keywords.
    await importKeywordFiles(pool, projectId, [
      { fileName: 'b.csv', rows: [{ keyword: 'защита ip68', frequency: 777, region: '' }, { keyword: 'оклейка авто владивосток', frequency: 5, region: '' }, { keyword: 'оклейка авто такси', frequency: 4, region: '' }] },
    ])
    assert.deepEqual(await statusOf(pool, projectId, 'защита ip68'), before, 'frequency update does not reset the classification')
    const summary = await getRelevanceSummary(pool, projectId)
    assert.deepEqual({ total: summary.total, unclassified: summary.unclassified }, { total: 5, unclassified: 2 })

    const ai = fakeAi()
    const job = await cleanupKeywordsForProject(pool, projectId, { llm: ai.llm })
    assert.deepEqual(ai.calls.flatMap((c) => c.queries).sort(), ['оклейка авто владивосток', 'оклейка авто такси'])
    assert.equal(job.result?.checked, 2)

    const idle = fakeAi()
    await assert.rejects(createRelevanceJob(pool, projectId), RelevanceError)
    assert.equal(idle.calls.length, 0, 'nothing to check → no AI call')
  })
})

test('the AI leaving queries out: they get a second batch, then stay unclassified (not lost, not invented)', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    const ai = fakeAi({ omit: (q) => q === 'защита ip68' })
    const job = await cleanupKeywordsForProject(pool, projectId, { llm: ai.llm })
    assert.ok(job.batches.some((b) => b.orphan))
    assert.equal(job.result?.unresolved, 1)
    assert.equal((await statusOf(pool, projectId, 'защита ip68')).s, null)
    assert.equal(await countKeywords(pool, projectId), 6)
  })
})

test('clustering input: legacy project (never cleaned) takes every keyword as before', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    assert.equal((await clusteredQueries(projectId, pool)).length, 6)
    // Only an explicit human "irrelevant" is respected even without cleanup.
    const id = (await pool.query(`SELECT id FROM keywords WHERE project_id = $1 AND query = 'защита ip68'`, [projectId])).rows[0].id
    await setKeywordRelevance(pool, { projectId, keywordId: id, status: 'irrelevant' })
    assert.equal((await clusteredQueries(projectId, pool)).includes('защита ip68'), false)
    assert.equal((await clusteredQueries(projectId, pool)).length, 5)
  })
})

test('clustering input after cleanup: only target + informational; irrelevant, geo_mismatch, uncertain and unchecked wait out', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    assert.deepEqual(await clusteredQueries(projectId, pool), ['какой пленкой лучше оклеить автомобиль', 'оклейка авто цена'])
    // New unclassified keyword after cleanup: not clustered until it is classified.
    await pool.query(`INSERT INTO keywords (project_id, query, frequency, region) VALUES ($1, 'оклейка авто свежий запрос', 1, '')`, [projectId])
    assert.equal((await clusteredQueries(projectId, pool)).includes('оклейка авто свежий запрос'), false)
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    assert.equal((await clusteredQueries(projectId, pool)).includes('оклейка авто свежий запрос'), true)
  })
})

test('clustering reads the LIVE status: manual uncertain→target is clustered, target→irrelevant is not, no re-cleanup needed', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    const idOf = async (q: string) => (await pool.query('SELECT id FROM keywords WHERE project_id = $1 AND query = $2', [projectId, q])).rows[0].id
    await setKeywordRelevance(pool, { projectId, keywordId: await idOf('оклейка авто такси'), status: 'target' })
    await setKeywordRelevance(pool, { projectId, keywordId: await idOf('оклейка авто цена'), status: 'irrelevant' })
    const queries = await clusteredQueries(projectId, pool)
    assert.equal(queries.includes('оклейка авто такси'), true)
    assert.equal(queries.includes('оклейка авто цена'), false)
    // Resetting a keyword to "not checked" takes it out again until the next cleanup.
    await setKeywordRelevance(pool, { projectId, keywordId: await idOf('оклейка авто такси'), status: null })
    assert.equal((await clusteredQueries(projectId, pool)).includes('оклейка авто такси'), false)
  })
})

test('the list API filters by status and by "unclassified"', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    assert.equal((await listKeywordRelevance(pool, projectId, { status: 'unclassified', limit: 50, offset: 0 })).total, 6)
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    assert.equal((await listKeywordRelevance(pool, projectId, { status: 'unclassified', limit: 50, offset: 0 })).total, 0)
    const uncertain = await listKeywordRelevance(pool, projectId, { status: 'uncertain', limit: 50, offset: 0 })
    assert.deepEqual(uncertain.rows.map((r) => r.query).sort(), ['оклейка авто сомнение', 'оклейка авто такси'])
    assert.equal((await listKeywordRelevance(pool, projectId, { limit: 4, offset: 0 })).rows.length, 4)
  })
})

test('a project with no pages: exclusions are held as uncertain, nothing is excluded blind', async (t) => {
  await withProject(
    t,
    ['оклейка авто москва', 'защита ip68', 'оклейка авто цена'],
    async (pool, projectId) => {
      // The AI blindly says "other region" for Moscow and "irrelevant" for junk, with high confidence.
      const ai = fakeAi({ judge: (q) => (q.includes('москва') ? { status: 'geo_mismatch', confidence: 90, reason: 'Указан город вне региона проекта' } : undefined) })
      const job = await cleanupKeywordsForProject(pool, projectId, { llm: ai.llm })
      assert.equal(job.hasContext, false)
      assert.equal(job.result?.heldNoContext, 2)
      assert.equal((await statusOf(pool, projectId, 'оклейка авто москва')).s, 'uncertain')
      assert.equal((await statusOf(pool, projectId, 'защита ip68')).s, 'uncertain')
      assert.match((await statusOf(pool, projectId, 'защита ip68')).r, /Нет данных о проекте/)
      assert.equal((await statusOf(pool, projectId, 'оклейка авто цена')).s, 'target')
      assert.equal((await getRelevanceSummary(pool, projectId)).pages, 0)
    },
    { pages: false },
  )
})

test('recheck disputed: only the AI uncertain / geo_mismatch keywords go back to the AI; manual ones and other statuses stay', async (t) => {
  await withProject(t, ['оклейка авто москва', 'химчистка салона москва', 'оклейка авто такси', 'защита ip68', 'оклейка авто цена', 'полировка фар москва'], async (pool, projectId) => {
    // First (blind) run: Moscow queries wrongly marked as another region.
    await cleanupKeywordsForProject(pool, projectId, {
      llm: fakeAi({ judge: (q) => (q.includes('москва') ? { status: 'geo_mismatch', confidence: 90, reason: 'Указан город вне региона проекта' } : undefined) }).llm,
    })
    const idOf = async (q: string) => (await pool.query('SELECT id FROM keywords WHERE project_id = $1 AND query = $2', [projectId, q])).rows[0].id
    // A person decided one of the disputed ones by hand: it must be left alone.
    await setKeywordRelevance(pool, { projectId, keywordId: await idOf('полировка фар москва'), status: 'irrelevant' })
    const before = await getRelevanceSummary(pool, projectId)
    assert.deepEqual({ geo: before.geo_mismatch, uncertain: before.uncertain, disputed: before.disputed }, { geo: 2, uncertain: 1, disputed: 3 })

    const { requeueDisputedKeywords } = await import('./keywords-relevance.ts')
    assert.equal(await requeueDisputedKeywords(pool, projectId), 3)
    assert.deepEqual(await statusOf(pool, projectId, 'оклейка авто москва'), { s: null, c: null, r: null, m: false })
    assert.equal((await statusOf(pool, projectId, 'защита ip68')).s, 'irrelevant')
    assert.equal((await statusOf(pool, projectId, 'оклейка авто цена')).s, 'target')
    assert.deepEqual(await statusOf(pool, projectId, 'полировка фар москва'), { s: 'irrelevant', c: null, r: 'Решение пользователя', m: true })

    // Second run with context (the page says "в Москве"): the AI now accepts the Moscow queries.
    const ai = fakeAi({ judge: (q, prompt) => (q.includes('москва') && prompt.includes('в Москве') ? { status: 'target', confidence: 92, reason: 'Основная услуга проекта' } : undefined) })
    const job = await cleanupKeywordsForProject(pool, projectId, { llm: ai.llm })
    assert.deepEqual(ai.calls.flatMap((c) => c.queries).sort(), ['химчистка салона москва', 'оклейка авто москва', 'оклейка авто такси'].sort())
    assert.equal(job.hasContext, true)
    assert.equal((await statusOf(pool, projectId, 'оклейка авто москва')).s, 'target')
    assert.equal((await statusOf(pool, projectId, 'химчистка салона москва')).s, 'target')
    assert.equal((await statusOf(pool, projectId, 'оклейка авто такси')).s, 'uncertain', 'genuinely unclear stays unclear')
    assert.equal((await statusOf(pool, projectId, 'полировка фар москва')).s, 'irrelevant', 'manual decision untouched')
  })
})

// ---- Project SEO context (explicit, per project) ----

const DETAILING = {
  businessType: 'автомобильный детейлинг',
  region: 'Москва и Московская область',
  services: 'оклейка автомобилей пленкой\nполировка кузова\nполировка фар\nхимчистка салона',
  plannedServices: 'оклейка коммерческого транспорта\nоклейка фургонов и микроавтобусов',
  excluded: 'полировальные машинки\nпылесосы\nполироли и пасты',
}

/** A model that follows the prompt: it uses the SEO context it is given; blind, it guesses badly (Moscow → other region). */
const followsContext = (q: string, prompt: string): Answer | undefined => {
  const region = prompt.includes('TARGET REGION: Москва')
  if (q.includes('в москве')) return region ? { status: 'target', confidence: 92, reason: 'Основная услуга проекта' } : { status: 'geo_mismatch', confidence: 90, reason: 'Указан город вне региона проекта' }
  // Match the planned-direction bullet of the context, not the query text (the prompt contains both).
  if (q.includes('фургон')) return prompt.includes('- оклейка фургонов и микроавтобусов') ? { status: 'target', confidence: 90, reason: 'Планируемое направление проекта' } : { status: 'uncertain', confidence: 60, reason: 'Нужно решение: сегмент не подтверждён' }
  if (q.includes('пылесос')) return prompt.includes('- пылесосы') ? { status: 'irrelevant', confidence: 96, reason: 'Проект не продаёт это оборудование' } : { status: 'uncertain', confidence: 60, reason: 'Неясно, продаёт ли проект оборудование' }
  if (q.includes('владивосток')) return { status: 'geo_mismatch', confidence: 90, reason: 'Указан регион вне региона проекта' }
  return undefined
}

const CONTEXT_QUERIES = ['полировка фар в москве', 'оклейка фургонов цена', 'пылесос для химчистки салона', 'полировка кузова владивосток', 'оклейка авто цена']

test('cleanup uses the project SEO context even with 0 pages; the AI is given it and exclusions are allowed', async (t) => {
  await withProject(
    t,
    CONTEXT_QUERIES,
    async (pool, projectId) => {
      await saveProjectSeoContext(pool, projectId, DETAILING)
      const ai = fakeAi({ judge: followsContext })
      const job = await cleanupKeywordsForProject(pool, projectId, { llm: ai.llm })
      assert.deepEqual(job.contextCaps, { business: true, region: true })
      assert.equal(job.result?.heldNoContext, 0)
      assert.match(ai.calls[0].prompt, /BUSINESS TYPE: автомобильный детейлинг/)
      assert.match(ai.calls[0].prompt, /TARGET REGION: Москва и Московская область/)
      assert.match(ai.calls[0].prompt, /PLANNED[^\n]*\n- оклейка коммерческого транспорта/)
      assert.match(ai.calls[0].prompt, /NOT OFFERED[^\n]*\n- полировальные машинки/)
      assert.equal((await getRelevanceSummary(pool, projectId)).seoContext, true)
      assert.equal((await getRelevanceSummary(pool, projectId)).pages, 0)
      assert.equal((await statusOf(pool, projectId, 'полировка кузова владивосток')).s, 'geo_mismatch', 'a region the context does not name can be excluded')
    },
    { pages: false },
  )
})

test('Moscow in the context: «полировка фар в москве» is not geo_mismatch; without any context the blind answer is held', async (t) => {
  await withProject(
    t,
    ['полировка фар в москве'],
    async (pool, projectId) => {
      await saveProjectSeoContext(pool, projectId, DETAILING)
      await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi({ judge: followsContext }).llm })
      assert.equal((await statusOf(pool, projectId, 'полировка фар в москве')).s, 'target')
    },
    { pages: false },
  )
  await withProject(
    t,
    ['полировка фар в москве'],
    async (pool, projectId) => {
      // No context, no pages: the model guesses geo_mismatch, the guard keeps it as uncertain.
      const job = await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi({ judge: followsContext }).llm })
      assert.equal(job.result?.heldNoContext, 1)
      const row = await statusOf(pool, projectId, 'полировка фар в москве')
      assert.equal(row.s, 'uncertain')
      assert.match(row.r, /Регион проекта не задан/)
    },
    { pages: false },
  )
})

test('a planned direction counts as part of the business without any page for it; the negative control stays uncertain', async (t) => {
  await withProject(
    t,
    ['оклейка фургонов цена'],
    async (pool, projectId) => {
      await saveProjectSeoContext(pool, projectId, DETAILING)
      await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi({ judge: followsContext }).llm })
      assert.equal((await statusOf(pool, projectId, 'оклейка фургонов цена')).s, 'target')
    },
    { pages: false },
  )
  await withProject(
    t,
    ['оклейка фургонов цена'],
    async (pool, projectId) => {
      await saveProjectSeoContext(pool, projectId, { ...DETAILING, plannedServices: '' })
      await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi({ judge: followsContext }).llm })
      assert.equal((await statusOf(pool, projectId, 'оклейка фургонов цена')).s, 'uncertain')
    },
    { pages: false },
  )
})

test('explicitly excluded goods and equipment can be irrelevant; without a region the geo exclusion alone is held', async (t) => {
  await withProject(
    t,
    ['пылесос для химчистки салона', 'полировка кузова владивосток'],
    async (pool, projectId) => {
      await saveProjectSeoContext(pool, projectId, { ...DETAILING, region: '' })
      const job = await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi({ judge: followsContext }).llm })
      assert.deepEqual(job.contextCaps, { business: true, region: false })
      assert.equal((await statusOf(pool, projectId, 'пылесос для химчистки салона')).s, 'irrelevant')
      assert.equal((await statusOf(pool, projectId, 'полировка кузова владивосток')).s, 'uncertain', 'no region known → cannot call it another region')
    },
    { pages: false },
  )
})

test('SEO context is saved per project, trimmed and capped; empty until saved; unknown project rejected', async (t) => {
  await withProject(t, [], async (pool, projectId) => {
    assert.equal(await getProjectSeoContext(pool, projectId), null)
    const saved = await saveProjectSeoContext(pool, projectId, { ...DETAILING, businessType: '  автомобильный детейлинг  ', excluded: 'x'.repeat(5000) })
    assert.equal(saved.businessType, 'автомобильный детейлинг')
    assert.equal(saved.excluded.length, 2000)
    assert.deepEqual(await getProjectSeoContext(pool, projectId), saved)
    // Replaced, not merged.
    await saveProjectSeoContext(pool, projectId, { region: 'Казань' })
    assert.deepEqual(await getProjectSeoContext(pool, projectId), { businessType: '', region: 'Казань', services: '', plannedServices: '', excluded: '' })
    await assert.rejects(saveProjectSeoContext(pool, 999999999, DETAILING), SeoContextError)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_seo_context WHERE project_id = $1', [projectId])).rows[0].n, 1)
  })
})

test('full recheck resets every AI decision and nothing else; manual decisions stay; ordinary cleanup then re-processes exactly the reset ones', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    const idOf = async (q: string) => (await pool.query('SELECT id FROM keywords WHERE project_id = $1 AND query = $2', [projectId, q])).rows[0].id
    await setKeywordRelevance(pool, { projectId, keywordId: await idOf('оклейка авто такси'), status: 'target' })
    await setKeywordRelevance(pool, { projectId, keywordId: await idOf('защита ip68'), status: 'informational' })
    const kwId = await idOf('оклейка авто цена')
    const cluster = (await pool.query(`INSERT INTO seo_clusters (project_id, name, primary_keyword_id) VALUES ($1, 'кластер', $2) RETURNING id`, [projectId, kwId])).rows[0].id
    await pool.query('INSERT INTO seo_cluster_keywords (cluster_id, keyword_id) VALUES ($1, $2)', [cluster, kwId])
    const snapshot = async () =>
      (await pool.query(`SELECT count(*)::int AS n, coalesce(sum(frequency), 0)::int AS freq, count(DISTINCT id)::int AS ids FROM keywords WHERE project_id = $1`, [projectId])).rows[0]
    const before = await snapshot()
    const summary = await getRelevanceSummary(pool, projectId)
    assert.equal(summary.aiDecided, 4)
    assert.equal(summary.manual, 2)

    assert.equal(await requeueAllAiDecisions(pool, projectId), 4)
    assert.deepEqual(await snapshot(), before, 'keywords and frequencies untouched')
    for (const q of ['оклейка авто цена', 'какой пленкой лучше оклеить автомобиль', 'оклейка авто владивосток', 'оклейка авто сомнение']) {
      assert.deepEqual(await statusOf(pool, projectId, q), { s: null, c: null, r: null, m: false }, q)
    }
    assert.deepEqual(await statusOf(pool, projectId, 'оклейка авто такси'), { s: 'target', c: null, r: 'Решение пользователя', m: true })
    assert.deepEqual(await statusOf(pool, projectId, 'защита ip68'), { s: 'informational', c: null, r: 'Решение пользователя', m: true })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM seo_clusters WHERE id = $1', [cluster])).rows[0].n, 1, 'clusters untouched')
    assert.equal((await getRelevanceSummary(pool, projectId)).aiDecided, 0)

    const ai = fakeAi()
    await cleanupKeywordsForProject(pool, projectId, { llm: ai.llm })
    assert.deepEqual(
      ai.calls.flatMap((c) => c.queries).sort(),
      ['оклейка авто цена', 'какой пленкой лучше оклеить автомобиль', 'оклейка авто владивосток', 'оклейка авто сомнение'].sort(),
    )
    assert.equal((await statusOf(pool, projectId, 'оклейка авто такси')).m, true)
    assert.equal((await getRelevanceSummary(pool, projectId)).unclassified, 0)
  })
})

test('the existing partial recheck still resets only the AI disputed ones', async (t) => {
  await withProject(t, SAMPLE, async (pool, projectId) => {
    await cleanupKeywordsForProject(pool, projectId, { llm: fakeAi().llm })
    const { requeueDisputedKeywords } = await import('./keywords-relevance.ts')
    // uncertain: такси, сомнение (downgrade); geo_mismatch: владивосток.
    assert.equal(await requeueDisputedKeywords(pool, projectId), 3)
    assert.equal((await statusOf(pool, projectId, 'оклейка авто цена')).s, 'target')
    assert.equal((await statusOf(pool, projectId, 'защита ip68')).s, 'irrelevant')
    assert.equal((await statusOf(pool, projectId, 'оклейка авто такси')).s, null)
  })
})
