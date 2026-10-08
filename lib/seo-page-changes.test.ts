import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { createProject } from './projects-registry.ts'
import { saveSeoSnapshot } from './seo-observer.ts'
import { createPageChange, linkAfterSnapshots, listPageChanges, registerFixChange, snapshotPreference, summarizeRows } from './seo-page-changes.ts'

// ---- pure: metrics, preference, no query→URL attribution ------------------------------------------------------------------

test('summarizeRows: Webmaster = project-wide impressions / clicks / impression-weighted position; malformed rows are skipped', () => {
  const m = summarizeRows('yandex_webmaster', 'queries', [
    { query: 'a', impressions: 100, clicks: 10, avgPosition: 2 },
    { query: 'b', impressions: 300, clicks: 5, avgPosition: 6 },
    { query: 'bad', impressions: 'x', clicks: null },
    null,
  ], null)
  assert.deepEqual(m, { impressions: 400, clicks: 15, avgPosition: 5 })
  assert.deepEqual(summarizeRows('yandex_webmaster', 'queries', [], null), { impressions: 0, clicks: 0, avgPosition: null })
})

test('summarizeRows: Metrika = total visits and the exact page URL visits; Webmaster never gets page metrics (no query→URL attribution)', () => {
  const rows = [{ path: '/a', url: 'https://x.ru/a', visits: 7 }, { path: '/b', url: 'https://x.ru/b', visits: 3 }]
  assert.deepEqual(summarizeRows('yandex_metrika', 'organic_pages', rows, 'https://x.ru/a'), { visits: 10, pageVisits: 7 })
  assert.deepEqual(summarizeRows('yandex_metrika', 'organic_pages', rows, 'https://x.ru/zzz'), { visits: 10, pageVisits: null })
  assert.deepEqual(summarizeRows('yandex_metrika', 'organic_pages', rows, null), { visits: 10 })
  const wm = summarizeRows('yandex_webmaster', 'queries', [{ query: 'https://x.ru/a', impressions: 5, clicks: 1, avgPosition: 3 }], 'https://x.ru/a')
  assert.ok(!('pageVisits' in wm) && !('visits' in wm)) // a query that looks like the page URL is still just a query
  const src = readFileSync(new URL('./seo-page-changes.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /confirmed_page_id|keyword_pages|seo_clusters/)
})

test('snapshot preference: page-level → Metrika pages first; project-level → Webmaster queries first', () => {
  assert.equal(snapshotPreference(true)[0].provider, 'yandex_metrika')
  assert.equal(snapshotPreference(false)[0].provider, 'yandex_webmaster')
})

// ---- Postgres (skipped without migrations 0017 + 0019) --------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'
let seq = 0
async function withDb(t: TestContext, fn: (pool: Pool, project: { id: number; domain: string }) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT 1 FROM seo_snapshots LIMIT 1')
    await pool.query('SELECT 1 FROM page_changes LIMIT 1')
    await pool.query('SELECT archived_at, repository FROM projects LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with migrations 0017+0018+0019 — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const tag = `pc${Date.now()}${++seq}`
  try {
    const created = await createProject(pool, { name: `__${tag}`, slug: tag, domain: `https://${tag}.example.com` })
    assert.ok(created.ok)
    await fn(pool, { id: created.ok ? created.project.id : 0, domain: `https://${tag}.example.com` })
  } finally {
    await pool.query('DELETE FROM clients WHERE name LIKE $1', [`__${tag}%`])
    await pool.end()
  }
}

const snap = (pool: Pool, projectId: number, provider: 'yandex_webmaster' | 'yandex_metrika', kind: 'queries' | 'organic_pages', rows: unknown[] = [], takenAt?: string) =>
  saveSeoSnapshot(pool, projectId, { provider, kind, dateFrom: '2026-09-09', dateTo: '2026-10-06', rows }).then(async (id) => {
    if (takenAt) await pool.query('UPDATE seo_snapshots SET taken_at = $1 WHERE id = $2', [takenAt, id])
    return id
  })
const addPage = async (pool: Pool, projectId: number, url: string) => Number((await pool.query('INSERT INTO pages (project_id, url) VALUES ($1, $2) RETURNING id', [projectId, url])).rows[0].id)
const rowsOf = async (pool: Pool, projectId: number) => (await pool.query('SELECT * FROM page_changes WHERE project_id = $1 ORDER BY id', [projectId])).rows

test('registerFixChange: one FIX change per PR; project-level issue → page_id NULL; status pr_created; codes + notes stored', async (t) => {
  await withDb(t, async (pool, project) => {
    const r = await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/1', issues: [{ code: 'robots_missing' }, { code: 'robots_missing' }] })
    assert.equal(r.created, true)
    const [row] = await rowsOf(pool, project.id)
    assert.deepEqual([row.kind, row.status, row.page_id, row.pr_url, row.issue_codes, row.merged_at, row.after_snapshot_id], ['fix', 'pr_created', null, 'https://github.com/o/r/pull/1', ['robots_missing'], null, null])
  })
})

test('page issue with an exact known URL gets page_id; several pages / unknown URL / mixed project-level → NULL', async (t) => {
  await withDb(t, async (pool, project) => {
    const a = await addPage(pool, project.id, `${project.domain}/a`)
    await addPage(pool, project.id, `${project.domain}/b`)
    await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/1', issues: [{ code: 'title_missing', url: `${project.domain}/a` }, { code: 'h1_missing', url: `${project.domain}/a` }] })
    await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/2', issues: [{ code: 'title_missing', url: `${project.domain}/a` }, { code: 'title_missing', url: `${project.domain}/b` }] })
    await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/3', issues: [{ code: 'title_missing', url: `${project.domain}/unknown` }] })
    await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/4', issues: [{ code: 'title_missing', url: `${project.domain}/a` }, { code: 'robots_missing' }] })
    const rows = await rowsOf(pool, project.id)
    assert.deepEqual(rows.map((r) => r.page_id), [a, null, null, null])
    assert.deepEqual(rows[0].issue_codes, ['h1_missing', 'title_missing'])
  })
})

test('idempotency: the same PR registered twice creates one row; another PR creates another', async (t) => {
  await withDb(t, async (pool, project) => {
    const input = { projectId: project.id, prUrl: 'https://github.com/o/r/pull/9', issues: [{ code: 'robots_missing' }] }
    const first = await registerFixChange(pool, input)
    const again = await registerFixChange(pool, input)
    assert.deepEqual([first.created, again.created, again.id], [true, false, first.id])
    assert.equal((await rowsOf(pool, project.id)).length, 1)
    await registerFixChange(pool, { ...input, prUrl: 'https://github.com/o/r/pull/10' })
    assert.equal((await rowsOf(pool, project.id)).length, 2)
  })
})

test('baseline = the latest EXISTING suitable snapshot (never created); no snapshot → NULL and that is fine', async (t) => {
  await withDb(t, async (pool, project) => {
    await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/1', issues: [{ code: 'robots_missing' }] })
    assert.equal((await rowsOf(pool, project.id))[0].baseline_snapshot_id, null)
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM seo_snapshots WHERE project_id = $1', [project.id])).rows[0].n, 0) // no snapshot made for the baseline

    const old = await snap(pool, project.id, 'yandex_webmaster', 'queries', [], '2026-09-01T00:00:00Z')
    const latest = await snap(pool, project.id, 'yandex_webmaster', 'queries', [], '2026-10-01T00:00:00Z')
    await snap(pool, project.id, 'yandex_metrika', 'organic_pages')
    await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/2', issues: [{ code: 'robots_missing' }] }) // project-level → queries
    const [, second] = await rowsOf(pool, project.id)
    assert.equal(Number(second.baseline_snapshot_id), latest)
    assert.notEqual(Number(second.baseline_snapshot_id), old)
  })
})

test('after: a snapshot taken AFTER the change (same provider/kind as the baseline) is linked; the next one does not replace it', async (t) => {
  await withDb(t, async (pool, project) => {
    const baseline = await snap(pool, project.id, 'yandex_webmaster', 'queries', [{ query: 'q', impressions: 100, clicks: 10, avgPosition: 4 }], '2026-10-01T00:00:00Z')
    await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/1', issues: [{ code: 'robots_missing' }] })
    const otherKind = await snap(pool, project.id, 'yandex_metrika', 'organic_pages') // later, but a different provider/kind
    assert.equal(await linkAfterSnapshots(pool, project.id), 0)
    assert.equal((await rowsOf(pool, project.id))[0].after_snapshot_id, null)
    assert.notEqual(otherKind, baseline)

    const after = await snap(pool, project.id, 'yandex_webmaster', 'queries', [{ query: 'q', impressions: 150, clicks: 20, avgPosition: 3 }])
    assert.equal(await linkAfterSnapshots(pool, project.id), 1)
    const [row] = await rowsOf(pool, project.id)
    assert.deepEqual([Number(row.baseline_snapshot_id), Number(row.after_snapshot_id), row.status], [baseline, after, 'after_linked'])

    await snap(pool, project.id, 'yandex_webmaster', 'queries')
    assert.equal(await linkAfterSnapshots(pool, project.id), 0) // already closed
    assert.equal(Number((await rowsOf(pool, project.id))[0].after_snapshot_id), after)

    const [view] = await listPageChanges(pool, project.id)
    assert.deepEqual(view.comparison?.before, { impressions: 100, clicks: 10, avgPosition: 4 })
    assert.deepEqual(view.comparison?.after, { impressions: 150, clicks: 20, avgPosition: 3 })
    assert.equal(view.comparison?.overlap, true) // the 28-day window ends before today, so it starts before the change
  })
})

test('an OLD snapshot (taken before the change) never becomes the after snapshot', async (t) => {
  await withDb(t, async (pool, project) => {
    const baseline = await snap(pool, project.id, 'yandex_webmaster', 'queries', [], '2026-09-01T00:00:00Z')
    await snap(pool, project.id, 'yandex_webmaster', 'queries', [], '2026-09-05T00:00:00Z') // also older than the change, not the baseline
    await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/1', issues: [{ code: 'robots_missing' }] })
    assert.equal(await linkAfterSnapshots(pool, project.id), 0)
    const [row] = await rowsOf(pool, project.id)
    assert.equal(row.after_snapshot_id, null)
    assert.notEqual(row.baseline_snapshot_id, null)
    assert.ok(baseline > 0)
  })
})

test('without any snapshots: the change is kept with baseline NULL; the first later snapshot becomes after; no comparison without a baseline', async (t) => {
  await withDb(t, async (pool, project) => {
    await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/1', issues: [{ code: 'robots_missing' }] })
    assert.equal(await linkAfterSnapshots(pool, project.id), 0)
    const first = await snap(pool, project.id, 'yandex_webmaster', 'queries')
    assert.equal(await linkAfterSnapshots(pool, project.id), 1)
    const [view] = await listPageChanges(pool, project.id)
    assert.deepEqual([view.baseline, view.after?.id, view.comparison], [null, first, null])
  })
})

test('Webmaster and Metrika stay separate in the comparison: a page-level change compares Metrika pages (page visits), never queries → URL', async (t) => {
  await withDb(t, async (pool, project) => {
    const url = `${project.domain}/a`
    await addPage(pool, project.id, url)
    await snap(pool, project.id, 'yandex_webmaster', 'queries', [{ query: url, impressions: 9, clicks: 9, avgPosition: 1 }], '2026-10-01T00:00:00Z')
    await snap(pool, project.id, 'yandex_metrika', 'organic_pages', [{ path: '/a', url, visits: 4 }], '2026-10-01T00:00:00Z')
    await registerFixChange(pool, { projectId: project.id, prUrl: 'https://github.com/o/r/pull/1', issues: [{ code: 'title_missing', url }] })
    await snap(pool, project.id, 'yandex_metrika', 'organic_pages', [{ path: '/a', url, visits: 8 }])
    await linkAfterSnapshots(pool, project.id)
    const [view] = await listPageChanges(pool, project.id)
    assert.equal(view.comparison?.provider, 'yandex_metrika')
    assert.deepEqual(view.comparison?.before, { visits: 4, pageVisits: 4 })
    assert.deepEqual(view.comparison?.after, { visits: 8, pageVisits: 8 })
    assert.ok(!JSON.stringify(view.comparison).includes('impressions'))
  })
})

test("kind 'improve' is supported by the store (cluster ids, no automatic registration anywhere)", async (t) => {
  await withDb(t, async (pool, project) => {
    const r = await createPageChange(pool, { projectId: project.id, kind: 'improve', prUrl: 'https://github.com/o/r/pull/5', clusterIds: [3, 4], status: 'pr_created' })
    assert.equal(r.created, true)
    const [view] = await listPageChanges(pool, project.id)
    assert.deepEqual([view.kind, view.clusterIds, view.issueCodes], ['improve', [3, 4], []])
    for (const f of ['./seo-executor.ts', '../app/api/seo-observer/route.ts', '../app/api/seo-page-changes/route.ts']) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /kind: 'improve'|'improve'/, f)
  })
})

test('read-only API route and wiring: GET only, no external providers, executor registers through the store', () => {
  const route = readFileSync(new URL('../app/api/seo-page-changes/route.ts', import.meta.url), 'utf8')
  assert.match(route, /export async function GET/)
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)|yandex|fetch\(/i)
  assert.match(readFileSync(new URL('../app/api/seo-executor/route.ts', import.meta.url), 'utf8'), /registerFixChange/)
  assert.doesNotMatch(readFileSync(new URL('./seo-page-changes.ts', import.meta.url), 'utf8'), /fetch\(|child_process|cron|setInterval/)
})
