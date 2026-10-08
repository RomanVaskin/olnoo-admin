import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { createProject } from './projects-registry.ts'
import { createPageChange, linkAfterSnapshots, listPageChanges, recordFixChanges, snapshotMetrics } from './seo-page-changes.ts'
import { startExecutorRun, getExecutorRun, resetExecutorRunsForTests, type ExecutorDeps } from './seo-executor.ts'
import type { Issue, ProjectHealth } from './seo-health.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'
let seq = 0
type Ctx = { pool: Pool; projectId: number; domain: string }
async function withDb(t: TestContext, fn: (c: Ctx) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT 1 FROM seo_snapshots LIMIT 1')
    await pool.query('SELECT 1 FROM page_changes LIMIT 1')
    await pool.query('SELECT archived_at FROM projects LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with migrations 0017+0019 — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const tag = `pc${Date.now()}${++seq}`
  try {
    const created = await createProject(pool, { name: `__${tag}`, slug: tag, domain: `https://${tag}.example.com` })
    assert.ok(created.ok)
    await fn({ pool, projectId: created.ok ? created.project.id : 0, domain: `https://${tag}.example.com` })
  } finally {
    await pool.query('DELETE FROM clients WHERE name LIKE $1', [`__${tag}%`])
    await pool.end()
  }
}
const snap = async (pool: Pool, projectId: number, provider: string, kind: string, rows: unknown[], takenAt: string): Promise<number> =>
  Number((await pool.query('INSERT INTO seo_snapshots (project_id, provider, kind, date_from, date_to, taken_at, rows) VALUES ($1,$2,$3,$4,$4,$5,$6::jsonb) RETURNING id', [projectId, provider, kind, '2026-09-01', takenAt, JSON.stringify(rows)])).rows[0].id)
const page = async (pool: Pool, projectId: number, url: string): Promise<number> => Number((await pool.query('INSERT INTO pages (project_id, url) VALUES ($1,$2) RETURNING id', [projectId, url])).rows[0].id)
const rowsOf = async (pool: Pool, projectId: number) => (await pool.query('SELECT * FROM page_changes WHERE project_id = $1 ORDER BY id', [projectId])).rows
const PR = 'https://github.com/o/r/pull/7'
const issue = (code: string, url?: string): Pick<Issue, 'code' | 'url'> => ({ code, ...(url ? { url } : {}) })

test('1/3: a FIX creates a page_change; a project-level issue has page_id NULL; status pr_created', async (t) => {
  await withDb(t, async ({ pool, projectId }) => {
    const ids = await recordFixChanges(pool, { projectId, prUrl: PR, issues: [issue('robots_missing')] })
    assert.equal(ids.length, 1)
    const [r] = await rowsOf(pool, projectId)
    assert.deepEqual([r.kind, r.page_id, r.pr_url, r.status, r.issue_codes], ['fix', null, PR, 'pr_created', ['robots_missing']])
    assert.equal(r.baseline_snapshot_id, null) // 5: no snapshots → NULL baseline is fine
  })
})

test('4 + granularity: one row per PR × page; same-page issues share a row; unknown URL falls to project-level', async (t) => {
  await withDb(t, async ({ pool, projectId, domain }) => {
    const a = await page(pool, projectId, `${domain}/a`)
    const b = await page(pool, projectId, `${domain}/b`)
    await recordFixChanges(pool, {
      projectId, prUrl: PR,
      issues: [issue('canonical_missing', `${domain}/a`), issue('title_missing', `${domain}/a`), issue('h1_missing', `${domain}/b`), issue('robots_missing'), issue('canonical_missing', `${domain}/unknown`)],
    })
    const rows = await rowsOf(pool, projectId)
    assert.equal(rows.length, 3)
    const by = new Map(rows.map((r) => [r.page_id, r.issue_codes]))
    assert.deepEqual(by.get(a), ['canonical_missing', 'title_missing'])
    assert.deepEqual(by.get(b), ['h1_missing'])
    assert.deepEqual(by.get(null), ['canonical_missing', 'robots_missing'])
  })
})

test('8: a repeated call for the same PR does not duplicate', async (t) => {
  await withDb(t, async ({ pool, projectId, domain }) => {
    await page(pool, projectId, `${domain}/a`)
    const input = { projectId, prUrl: PR, issues: [issue('title_missing', `${domain}/a`), issue('robots_missing')] }
    assert.equal((await recordFixChanges(pool, input)).length, 2)
    assert.equal((await recordFixChanges(pool, input)).length, 0)
    assert.equal((await rowsOf(pool, projectId)).length, 2)
    assert.equal((await recordFixChanges(pool, { ...input, prUrl: 'https://github.com/o/r/pull/8' })).length, 2) // another PR = another change
  })
})

test('5: baseline = the newest EXISTING snapshot (page-level prefers Metrika pages, project-level prefers Webmaster queries); nothing is created', async (t) => {
  await withDb(t, async ({ pool, projectId, domain }) => {
    await page(pool, projectId, `${domain}/a`)
    await snap(pool, projectId, 'yandex_webmaster', 'queries', [], '2026-10-01T00:00:00Z')
    const wNew = await snap(pool, projectId, 'yandex_webmaster', 'queries', [], '2026-10-02T00:00:00Z')
    const m = await snap(pool, projectId, 'yandex_metrika', 'organic_pages', [], '2026-10-01T00:00:00Z')
    const before = Number((await pool.query('SELECT COUNT(*) FROM seo_snapshots WHERE project_id = $1', [projectId])).rows[0].count)
    await recordFixChanges(pool, { projectId, prUrl: PR, issues: [issue('title_missing', `${domain}/a`), issue('robots_missing')] })
    const rows = await rowsOf(pool, projectId)
    assert.equal(rows.find((r) => r.page_id !== null).baseline_snapshot_id, String(m))
    assert.equal(rows.find((r) => r.page_id === null).baseline_snapshot_id, String(wNew))
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM seo_snapshots WHERE project_id = $1', [projectId])).rows[0].count), before)
  })
})

test('6/7: a snapshot taken AFTER the change (same provider/kind as baseline) becomes after; an older one never does', async (t) => {
  await withDb(t, async ({ pool, projectId }) => {
    const base = await snap(pool, projectId, 'yandex_webmaster', 'queries', [], '2026-10-01T00:00:00Z')
    const [id] = await recordFixChanges(pool, { projectId, prUrl: PR, issues: [issue('robots_missing')] })
    await pool.query("UPDATE page_changes SET created_at = '2026-10-03T00:00:00Z' WHERE id = $1", [id])
    const old = await snap(pool, projectId, 'yandex_webmaster', 'queries', [], '2026-10-02T00:00:00Z')
    const otherKind = await snap(pool, projectId, 'yandex_metrika', 'organic_pages', [], '2026-10-04T00:00:00Z')
    assert.deepEqual(await linkAfterSnapshots(pool, projectId, [old, otherKind]), []) // older / different provider+kind → not linked
    const fresh = await snap(pool, projectId, 'yandex_webmaster', 'queries', [], '2026-10-05T00:00:00Z')
    assert.deepEqual(await linkAfterSnapshots(pool, projectId, [fresh]), [Number(id)])
    const [r] = await rowsOf(pool, projectId)
    assert.deepEqual([r.baseline_snapshot_id, r.after_snapshot_id, r.status], [String(base), String(fresh), 'observed'])
    const later = await snap(pool, projectId, 'yandex_webmaster', 'queries', [], '2026-10-06T00:00:00Z')
    assert.deepEqual(await linkAfterSnapshots(pool, projectId, [later]), []) // already closed: never re-linked
  })
})

test('no baseline: the first new snapshot after the change (by preference) can still close it', async (t) => {
  await withDb(t, async ({ pool, projectId }) => {
    const [id] = await recordFixChanges(pool, { projectId, prUrl: PR, issues: [issue('robots_missing')] })
    await pool.query("UPDATE page_changes SET created_at = '2026-10-03T00:00:00Z' WHERE id = $1", [id])
    const m = await snap(pool, projectId, 'yandex_metrika', 'organic_pages', [], '2026-10-04T00:00:00Z')
    const w = await snap(pool, projectId, 'yandex_webmaster', 'queries', [], '2026-10-04T00:00:00Z')
    await linkAfterSnapshots(pool, projectId, [m, w])
    assert.equal((await rowsOf(pool, projectId))[0].after_snapshot_id, String(w)) // project-level prefers Webmaster
  })
})

test('9: Webmaster and Metrika stay separate — metrics are per source, a page change reads the page\'s own visits, never a query→URL join', async (t) => {
  const w = snapshotMetrics('yandex_webmaster', 'queries', [{ query: 'a', impressions: 100, clicks: 10, avgPosition: 4 }, { query: 'b', impressions: 100, clicks: 0, avgPosition: 8 }], 'https://x.ru/a')
  assert.deepEqual(w, { impressions: 200, clicks: 10, avgPosition: 6, visits: null })
  const rows = [{ url: 'https://x.ru/a', visits: 5 }, { url: 'https://x.ru/b', visits: 7 }]
  assert.deepEqual(snapshotMetrics('yandex_metrika', 'organic_pages', rows, 'https://x.ru/a'), { impressions: null, clicks: null, avgPosition: null, visits: 5 })
  assert.equal(snapshotMetrics('yandex_metrika', 'organic_pages', rows, null).visits, 12)
  assert.deepEqual(snapshotMetrics('other', 'x', rows, null), { impressions: null, clicks: null, avgPosition: null, visits: null })
  await withDb(t, async ({ pool, projectId, domain }) => {
    await page(pool, projectId, `${domain}/a`)
    await snap(pool, projectId, 'yandex_metrika', 'organic_pages', [{ url: `${domain}/a`, visits: 3 }], '2026-10-01T00:00:00Z')
    await snap(pool, projectId, 'yandex_webmaster', 'queries', [{ query: 'q', impressions: 50, clicks: 1, avgPosition: 3 }], '2026-10-01T00:00:00Z')
    await recordFixChanges(pool, { projectId, prUrl: PR, issues: [issue('title_missing', `${domain}/a`)] })
    const [c] = await listPageChanges(pool, projectId)
    assert.equal(c.baseline?.provider, 'yandex_metrika')
    assert.deepEqual(c.baseline?.metrics, { impressions: null, clicks: null, avgPosition: null, visits: 3 })
    assert.equal(c.pageUrl, `${domain}/a`)
    assert.equal(c.after, null)
  })
})

test('improve is supported by the model (kind=improve, cluster_ids) but nothing registers it automatically', async (t) => {
  await withDb(t, async ({ pool, projectId }) => {
    await createPageChange(pool, { projectId, kind: 'improve', prUrl: PR, clusterIds: [3, 4] })
    const [c] = await listPageChanges(pool, projectId)
    assert.deepEqual([c.kind, c.clusterIds, c.issueCodes], ['improve', [3, 4], []])
  })
  const caller = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
  assert.doesNotMatch(caller('./seo-executor.ts'), /improve/i)
})

// ---- Executor hook (no DB) ----------------------------------------------------------------------------------------------

const health = (issues: Issue[]): ProjectHealth => ({
  projectId: 1, projectName: 'P', domain: 'https://p.ru', sitemapUrl: null, site: { status: 'OK', httpStatus: 200 }, robots: { status: 'Missing', httpStatus: 404, disallowAll: false },
  sitemap: { status: 'OK', httpStatus: 200, urlCount: 1 }, pages: [], pagesTruncated: false, issues, errors: 0, warnings: issues.length, overall: 'Warning', checkedAt: '2026-01-01T00:00:00Z',
})
function execDeps(over: { status?: string; checkFails?: boolean; agentCode?: number; record?: ExecutorDeps['recordChange'] }) {
  const recorded: { projectId: number; prUrl: string; issues: Issue[] }[] = []
  const deps: ExecutorDeps = {
    getProject: async () => ({ id: 1, name: 'P', slug: 'p', repository: 'o/r' }),
    readLastResult: async () => health([{ severity: 'WARNING', code: 'robots_missing', message: 'm' }]),
    run: async (cmd, args) => {
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
      if (cmd === 'gh' && args[0] === 'repo') return ok('main\n')
      if (cmd === 'gh' && args[0] === 'pr') return ok(`${PR}\n`)
      if (cmd === 'claude') return { code: over.agentCode ?? 0, stdout: '', stderr: '' }
      if (cmd === 'git' && args[0] === 'status') return ok(over.status ?? '?? app/robots.ts\0')
      if (cmd === 'npm' && over.checkFails) return { code: 1, stdout: '', stderr: 'x' }
      return ok()
    },
    makeTempDir: async (id) => `/tmp/olnoo-seo-executor/${id}`,
    removeDir: async () => {},
    readFile: async (p) => (p.endsWith('package.json') ? JSON.stringify({ scripts: { test: 'x' } }) : null),
    now: () => new Date('2026-02-02T00:00:00Z'),
    newRunId: () => '12345678-1234-1234-1234-123456789abc',
    recordChange: over.record ?? (async (i) => { recorded.push(i) }),
  }
  return { deps, recorded }
}
const go = async (d: ExecutorDeps) => { resetExecutorRunsForTests(); const r = await startExecutorRun(d, { projectId: 1 }); if (r.ok) await r.done; return getExecutorRun(1)! }

test('1/2: pr_created records exactly once; no_changes / failed / failed_checks record nothing', async () => {
  const ok = execDeps({})
  assert.equal((await go(ok.deps)).status, 'pr_created')
  assert.equal(ok.recorded.length, 1)
  assert.equal(ok.recorded[0].prUrl, PR)
  assert.deepEqual(ok.recorded[0].issues.map((i) => i.code), ['robots_missing'])
  for (const over of [{ status: '' }, { agentCode: 1 }, { checkFails: true }]) {
    const x = execDeps(over)
    assert.notEqual((await go(x.deps)).status, 'pr_created')
    assert.equal(x.recorded.length, 0)
  }
})

test('a failing record never fails the run (the PR exists)', async () => {
  const x = execDeps({ record: async () => { throw new Error('db down') } })
  const run = await go(x.deps)
  assert.equal(run.status, 'pr_created')
  assert.equal(run.prUrl, PR)
})

test('wiring: Executor route records via recordFixChanges, Observer POST links after snapshots, read API is GET-only', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
  assert.match(read('../app/api/seo-executor/route.ts'), /recordFixChanges\(pool, info\)/)
  assert.match(read('../app/api/seo-observer/route.ts'), /linkAfterSnapshots\(pool, project\.id, savedIds\)/)
  const api = read('../app/api/seo-page-changes/route.ts')
  assert.match(api, /export async function GET/)
  assert.doesNotMatch(api, /export async function (POST|PUT|PATCH|DELETE)/)
  assert.match(read('../components/sections/seo-observer.tsx'), /api\/seo-page-changes\?projectId=/)
})
