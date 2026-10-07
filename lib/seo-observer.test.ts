import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { ALLOWED_FILTER_RE, organicPagesQuery, ORGANIC_FILTER, parseOrganicPages, parseStatResponse } from './yandex-metrika-report.ts'
import { createMetrikaClient, MetrikaApiError } from './yandex-metrika.ts'
import { computeCtr, createWebmasterClient, normalizeQueryRows, pickHostId, webmasterConfigFromEnv, WebmasterApiError } from './yandex-webmaster.ts'
import { buildPageUrl, getLatestSeoSnapshots, getOrganicPagesSnapshot, getSeoQuerySnapshot, observerPeriod, runSeoObserver, saveSeoSnapshot } from './seo-observer.ts'
import { createProject, updateProject } from './projects-registry.ts'

const NOW = new Date('2026-10-07T09:00:00Z')

// ---- A. Webmaster normaliser ----------------------------------------------------------------------------------------

test('Webmaster rows: impressions, clicks, average position; CTR is computed by code; zero impressions → ctr null', () => {
  const rows = normalizeQueryRows([
    { query_id: 'a', query_text: 'полировка кузова', indicators: { TOTAL_SHOWS: 200, TOTAL_CLICKS: 5, AVG_SHOW_POSITION: 7.456 } },
    { query_id: 'b', query_text: 'полировка фар', indicators: { TOTAL_SHOWS: 0, TOTAL_CLICKS: 0, AVG_SHOW_POSITION: 12 } },
  ])
  assert.deepEqual(rows[0], { query: 'полировка кузова', impressions: 200, clicks: 5, ctr: 2.5, avgPosition: 7.46 })
  assert.deepEqual(rows[1], { query: 'полировка фар', impressions: 0, clicks: 0, ctr: null, avgPosition: 12 })
  assert.equal(computeCtr(1, 3), 33.33)
  assert.equal(computeCtr(0, 0), null)
})

test('Webmaster rows: deterministic order (impressions desc, clicks desc, query asc) and a bounded result', () => {
  const rows = normalizeQueryRows(
    [
      { query_text: 'b', indicators: { TOTAL_SHOWS: 10, TOTAL_CLICKS: 1 } },
      { query_text: 'a', indicators: { TOTAL_SHOWS: 10, TOTAL_CLICKS: 1 } },
      { query_text: 'c', indicators: { TOTAL_SHOWS: 10, TOTAL_CLICKS: 3 } },
      { query_text: 'top', indicators: { TOTAL_SHOWS: 99, TOTAL_CLICKS: 0 } },
    ],
    3,
  )
  assert.deepEqual(rows.map((r) => r.query), ['top', 'c', 'a'])
})

// ---- B. malformed rows ------------------------------------------------------------------------------------------------

test('Webmaster: malformed rows are skipped, they never break the snapshot', () => {
  const rows = normalizeQueryRows([
    null,
    'text',
    { query_text: '', indicators: { TOTAL_SHOWS: 5 } },
    { query_text: 'no indicators' },
    { query_text: 'bad shows', indicators: { TOTAL_SHOWS: 'many' } },
    { query_text: 'negative', indicators: { TOTAL_SHOWS: -3 } },
    { query_text: 'good', indicators: { TOTAL_SHOWS: 4 } },
    { query_text: 'no position', indicators: { TOTAL_SHOWS: 2, TOTAL_CLICKS: 'x' } },
  ])
  assert.deepEqual(rows.map((r) => r.query), ['good', 'no position'])
  assert.deepEqual([rows[0].clicks, rows[0].avgPosition], [0, null])
  assert.deepEqual(normalizeQueryRows(undefined), [])
  assert.deepEqual(normalizeQueryRows({}), [])
})

// ---- Webmaster client (scripted network) -----------------------------------------------------------------------------

type Answer = { status?: number; body?: unknown } | 'fail'
async function withNetwork<T>(routes: Record<string, Answer>, fn: (calls: URL[], inits: RequestInit[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const calls: URL[] = []
  const inits: RequestInit[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    calls.push(u)
    inits.push(init ?? {})
    const key = Object.keys(routes).find((k) => `${u.origin}${u.pathname}` === k)
    const a = key ? routes[key] : { status: 404, body: {} }
    if (a === 'fail') throw new Error('network')
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 })
  }) as typeof fetch
  try {
    return await fn(calls, inits)
  } finally {
    globalThis.fetch = original
  }
}
const W = 'https://api.webmaster.yandex.net'
const NO_DELAY = { retry: { retryDelayMs: 0 } }
const HOSTS = { hosts: [{ host_id: 'http:driveset.ru:80', ascii_host_url: 'http://driveset.ru/' }, { host_id: 'https:driveset.ru:443', ascii_host_url: 'https://driveset.ru/', unicode_host_url: 'https://driveset.ru/' }, { host_id: 'https:other.ru:443', ascii_host_url: 'https://other.ru/' }] }
const popular = (queries: unknown[]) => ({ queries, date_from: '2026-09-09', date_to: '2026-10-06', count: queries.length })

test('Webmaster client: user → host lookup by domain (https preferred) → popular queries with the three indicators; read-only GETs; token only in the header', async () => {
  const routes: Record<string, Answer> = {
    [`${W}/v4/user`]: { body: { user_id: 777 } },
    [`${W}/v4/user/777/hosts`]: { body: HOSTS },
    [`${W}/v4/user/777/hosts/https%3Adriveset.ru%3A443/search-queries/popular`]: { body: popular([{ query_text: 'q', indicators: { TOTAL_SHOWS: 10, TOTAL_CLICKS: 1, AVG_SHOW_POSITION: 3 } }]) },
  }
  await withNetwork(routes, async (calls, inits) => {
    const client = createWebmasterClient({ token: 'SECRET-TOKEN' }, NO_DELAY)
    const rows = await client.popularQueries('https://driveset.ru', { from: '2026-09-09', to: '2026-10-06' })
    assert.deepEqual(rows, [{ query: 'q', impressions: 10, clicks: 1, ctr: 10, avgPosition: 3 }])
    const last = calls.at(-1)!
    assert.deepEqual(last.searchParams.getAll('query_indicator'), ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION'])
    assert.equal(last.searchParams.get('order_by'), 'TOTAL_SHOWS')
    assert.deepEqual([last.searchParams.get('date_from'), last.searchParams.get('date_to'), last.searchParams.get('limit')], ['2026-09-09', '2026-10-06', '500'])
    assert.ok(inits.every((i) => (i.method ?? 'GET') === 'GET' && (i.headers as Record<string, string>).Authorization === 'OAuth SECRET-TOKEN'))
    assert.ok(calls.every((u) => !u.toString().includes('SECRET-TOKEN')))
  })
})

test('Webmaster client: errors are classified and never carry the token; a site not in Webmaster is host_not_found', async () => {
  const kind = async (routes: Record<string, Answer>) => {
    try {
      await createWebmasterClient({ token: 'SECRET-TOKEN' }, NO_DELAY).popularQueries('https://driveset.ru', { from: '2026-09-09', to: '2026-10-06' })
      return 'ok'
    } catch (err) {
      assert.ok(err instanceof WebmasterApiError)
      assert.ok(!err.message.includes('SECRET-TOKEN'))
      return err.kind
    }
  }
  assert.equal(await withNetwork({ [`${W}/v4/user`]: { status: 401, body: {} } }, () => kind({})), 'auth')
  assert.equal(await withNetwork({ [`${W}/v4/user`]: 'fail' }, () => kind({})), 'network')
  assert.equal(await withNetwork({ [`${W}/v4/user`]: { body: { user_id: 1 } }, [`${W}/v4/user/1/hosts`]: { body: { hosts: [] } } }, () => kind({})), 'host_not_found')
  assert.equal(await withNetwork({ [`${W}/v4/user`]: { body: {} } }, () => kind({})), 'format')
  assert.equal(pickHostId(HOSTS.hosts, 'https://www.driveset.ru/'), 'https:driveset.ru:443')
  assert.equal(pickHostId(HOSTS.hosts, 'https://nope.ru'), null)
  assert.equal(webmasterConfigFromEnv({}), null)
  assert.deepEqual(webmasterConfigFromEnv({ YANDEX_WEBMASTER_TOKEN: ' t ' }), { token: 't' })
})

// ---- C / D. Metrika organic landing pages ---------------------------------------------------------------------------

test('Metrika organic pages: the query uses ym:s:startURLPath + ym:s:visits and the ORGANIC filter only (no Direct / other traffic)', () => {
  const q = organicPagesQuery()
  assert.deepEqual([q.dimensions, q.metrics, q.filters, q.limit], [['ym:s:startURLPath'], ['ym:s:visits'], "ym:s:lastsignTrafficSource=='organic'", 500])
  assert.equal(ORGANIC_FILTER, "ym:s:lastsignTrafficSource=='organic'")
  assert.ok(ALLOWED_FILTER_RE.test(q.filters!))
  assert.ok(!ALLOWED_FILTER_RE.test("ym:s:lastsignTrafficSource=='ad'")) // nothing but organic is accepted through this shape
  assert.ok(!ALLOWED_FILTER_RE.test("ym:s:lastsignTrafficSource=='organic' OR ym:s:lastsignTrafficSource=='ad'"))
})

test('Metrika client request: GET with the organic filter and landing path dimension, only the counter of the project', async () => {
  const statBody = { data: [{ dimensions: [{ name: '/polirovka-avto' }], metrics: [12] }], totals: [12], sampled: false }
  await withNetwork({ 'https://api-metrika.yandex.net/stat/v1/data': { body: statBody } }, async (calls, inits) => {
    const client = createMetrikaClient({ token: 'MT' }, { retry: { retryDelayMs: 0 } })
    const period = observerPeriod(NOW)
    const rows = await client.observeOrganicPages('driveset', period)
    assert.deepEqual(rows, [{ path: '/polirovka-avto', visits: 12 }])
    const u = calls[0]
    assert.equal(u.searchParams.get('dimensions'), 'ym:s:startURLPath')
    assert.equal(u.searchParams.get('metrics'), 'ym:s:visits')
    assert.equal(u.searchParams.get('filters'), "ym:s:lastsignTrafficSource=='organic'")
    assert.equal(u.searchParams.get('ids'), '113053562')
    assert.equal((inits[0].method ?? 'GET'), 'GET')
    await assert.rejects(client.observeOrganicPages('unknown-project', period), (e: unknown) => e instanceof MetrikaApiError && e.kind === 'unknown_project')
  })
})

test('Metrika rows: landing path and visits; URL is built from the project domain and cannot leave it; malformed rows are skipped', async () => {
  const parsed = parseOrganicPages(parseStatResponse({ data: [
    { dimensions: [{ name: '/b' }], metrics: [5] },
    { dimensions: [{ name: '/a' }], metrics: [5] },
    { dimensions: [{ name: '/top' }], metrics: [50] },
    { dimensions: [{ name: 'no-slash' }], metrics: [1] },
    { dimensions: [], metrics: [1] },
    { dimensions: [{ name: '/nan' }], metrics: [null] },
  ] }))
  assert.deepEqual(parsed, [{ path: '/top', visits: 50 }, { path: '/a', visits: 5 }, { path: '/b', visits: 5 }])
  const snap = await getOrganicPagesSnapshot({ id: 1, slug: 'driveset', domain: 'https://driveset.ru/' }, observerPeriod(NOW), {
    observeOrganicPages: async () => [...parsed, { path: '//evil.example/x', visits: 9 }],
  })
  assert.deepEqual(snap.rows.map((r) => r.url), ['https://driveset.ru/top', 'https://driveset.ru/a', 'https://driveset.ru/b'])
  assert.deepEqual([snap.provider, snap.kind], ['yandex_metrika', 'organic_pages'])
  assert.equal(buildPageUrl('https://driveset.ru', '/polirovka-avto?x=1'), 'https://driveset.ru/polirovka-avto?x=1')
  assert.equal(buildPageUrl('https://driveset.ru', '//evil.example'), null)
  assert.equal(buildPageUrl('not a url', '/a'), null)
})

test('period: the last 28 COMPLETE Moscow days — yesterday backwards, today excluded', () => {
  const p = observerPeriod(NOW)
  assert.deepEqual([p.from, p.to, p.complete], ['2026-09-09', '2026-10-06', true])
  const snapshot = getSeoQuerySnapshot({ id: 1, slug: 'x', domain: 'https://x.ru' }, p, { popularQueries: async (_d, per) => (assert.deepEqual(per, { from: '2026-09-09', to: '2026-10-06' }), []) })
  return snapshot.then((s) => assert.deepEqual([s.provider, s.kind, s.dateFrom, s.dateTo], ['yandex_webmaster', 'queries', '2026-09-09', '2026-10-06']))
})

// ---- E–G, I, J: storage, partial failure, not_configured, archived, page_changes (Postgres) -----------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'
let seq = 0
async function withDb(t: TestContext, fn: (pool: Pool, project: { id: number; slug: string; domain: string }) => Promise<void>) {
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
  const tag = `obs${Date.now()}${++seq}`
  try {
    const created = await createProject(pool, { name: `__${tag}`, slug: tag, domain: `https://${tag}.example.com` })
    assert.ok(created.ok)
    await fn(pool, { id: created.ok ? created.project.id : 0, slug: tag, domain: `https://${tag}.example.com` })
  } finally {
    await pool.query('DELETE FROM clients WHERE name LIKE $1', [`__${tag}%`])
    await pool.end()
  }
}

const count = async (pool: Pool, table: string, projectId: number) => (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE project_id = $1`, [projectId])).rows[0].n as number
const okWebmaster = { popularQueries: async () => [{ query: 'q', impressions: 10, clicks: 1, ctr: 10, avgPosition: 2 }] }
const okMetrika = { observeOrganicPages: async () => [{ path: '/a', visits: 3 }] }

test('snapshot store: saves provider / kind / date range / rows; latest per provider+kind is the newest', async (t) => {
  await withDb(t, async (pool, project) => {
    const base = { provider: 'yandex_webmaster' as const, kind: 'queries' as const, dateFrom: '2026-09-09', dateTo: '2026-10-06' }
    const first = await saveSeoSnapshot(pool, project.id, { ...base, rows: [{ query: 'old' }] })
    const second = await saveSeoSnapshot(pool, project.id, { ...base, rows: [{ query: 'new' }] })
    await saveSeoSnapshot(pool, project.id, { provider: 'yandex_metrika', kind: 'organic_pages', dateFrom: '2026-09-09', dateTo: '2026-10-06', rows: [] })
    const latest = await getLatestSeoSnapshots(pool, project.id)
    assert.equal(latest.length, 2)
    const q = latest.find((s) => s.kind === 'queries')!
    assert.deepEqual([q.id, q.id > first, q.id === second, q.provider, q.dateFrom, q.dateTo, q.rows], [second, true, true, 'yandex_webmaster', '2026-09-09', '2026-10-06', [{ query: 'new' }]])
    assert.deepEqual(latest.find((s) => s.kind === 'organic_pages')!.rows, []) // a real 0-row answer is stored
  })
})

test('manual run: both providers ok → two snapshots saved; period is the 28 complete days; takenAt present', async (t) => {
  await withDb(t, async (pool, project) => {
    const run = await runSeoObserver(pool, { ...project, slug: 'driveset' }, { webmaster: okWebmaster, metrika: okMetrika, now: () => NOW })
    assert.deepEqual([run.webmaster.status, run.metrika.status, run.partial, run.dateFrom, run.dateTo, run.takenAt], ['ok', 'ok', false, '2026-09-09', '2026-10-06', NOW.toISOString()])
    assert.equal(await count(pool, 'seo_snapshots', project.id), 2)
  })
})

test('partial failure: Webmaster ok + Metrika fails → the Webmaster snapshot is saved, the result is partial, no fake Metrika snapshot (and vice versa)', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = { ...project, slug: 'driveset' }
    const metrikaDown = { observeOrganicPages: async () => { throw new MetrikaApiError('upstream', 'Metrika is down') } }
    const a = await runSeoObserver(pool, p, { webmaster: okWebmaster, metrika: metrikaDown, now: () => NOW })
    assert.deepEqual([a.webmaster.status, a.metrika.status, a.partial], ['ok', 'error', true])
    assert.deepEqual(a.metrika.status === 'error' && a.metrika.kind, 'upstream')
    assert.deepEqual((await getLatestSeoSnapshots(pool, project.id)).map((s) => s.provider), ['yandex_webmaster'])

    const webmasterDown = { popularQueries: async () => { throw new WebmasterApiError('auth', 'Webmaster token is invalid or expired') } }
    const b = await runSeoObserver(pool, p, { webmaster: webmasterDown, metrika: okMetrika, now: () => NOW })
    assert.deepEqual([b.webmaster.status, b.metrika.status, b.partial], ['error', 'ok', true])
    const providers = (await getLatestSeoSnapshots(pool, project.id)).map((s) => s.provider).sort()
    assert.deepEqual(providers, ['yandex_metrika', 'yandex_webmaster']) // the earlier Webmaster snapshot is untouched, the new Metrika one is saved

    const bothDown = await runSeoObserver(pool, p, { webmaster: webmasterDown, metrika: metrikaDown, now: () => NOW })
    assert.deepEqual([bothDown.partial, bothDown.webmaster.status, bothDown.metrika.status], [false, 'error', 'error'])
    assert.equal(await count(pool, 'seo_snapshots', project.id), 2) // Webmaster (run a) + Metrika (run b); the failed runs added nothing
  })
})

test('not_configured: no token / no counter / site not in Webmaster → status not_configured and NO snapshot is created', async (t) => {
  await withDb(t, async (pool, project) => {
    const none = await runSeoObserver(pool, { ...project, slug: 'driveset' }, { webmaster: null, metrika: null, now: () => NOW })
    assert.deepEqual([none.webmaster, none.metrika], [{ status: 'not_configured', reason: 'no_token' }, { status: 'not_configured', reason: 'no_token' }])
    const noCounter = await runSeoObserver(pool, project, { webmaster: okWebmaster, metrika: okMetrika, now: () => NOW }) // slug has no Metrika counter
    assert.deepEqual(noCounter.metrika, { status: 'not_configured', reason: 'no_counter_for_project' })
    assert.equal(noCounter.webmaster.status, 'ok')
    const noHost = await runSeoObserver(pool, { ...project, slug: 'driveset' }, {
      webmaster: { popularQueries: async () => { throw new WebmasterApiError('host_not_found', 'x') } }, metrika: null, now: () => NOW,
    })
    assert.deepEqual(noHost.webmaster, { status: 'not_configured', reason: 'host_not_found' })
    assert.equal(await count(pool, 'seo_snapshots', project.id), 1) // only the one successful Webmaster snapshot above
  })
})

test('page_changes exists (schema only) and the Observer writes nothing into it', async (t) => {
  await withDb(t, async (pool, project) => {
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'page_changes'`)).rows.map((r) => r.column_name)
    for (const c of ['id', 'project_id', 'page_id', 'kind', 'pr_url', 'merged_at', 'cluster_ids', 'issue_codes', 'baseline_snapshot_id', 'after_snapshot_id', 'status', 'notes', 'created_at']) assert.ok(cols.includes(c), c)
    await runSeoObserver(pool, { ...project, slug: 'driveset' }, { webmaster: okWebmaster, metrika: okMetrika, now: () => NOW })
    assert.equal(await count(pool, 'page_changes', project.id), 0)
    for (const f of ['./seo-observer.ts', '../app/api/seo-observer/route.ts', './yandex-webmaster.ts']) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /page_changes/, f)
  })
})

test('archived project: the Observer route refuses it (404), registry marks it archived', async (t) => {
  await withDb(t, async (pool, project) => {
    assert.ok((await updateProject(pool, project.id, { archived: true })).ok)
    const route = readFileSync(new URL('../app/api/seo-observer/route.ts', import.meta.url), 'utf8')
    assert.match(route, /p && !p\.archived_at \? p : null/)
    assert.equal((route.match(/status: 404/g) ?? []).length, 2) // GET and POST
  })
})

// ---- H. GET never calls a provider; secrets -------------------------------------------------------------------------

test('GET /api/seo-observer reads saved snapshots only — no provider client in its code path', () => {
  const route = readFileSync(new URL('../app/api/seo-observer/route.ts', import.meta.url), 'utf8')
  const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'))
  assert.match(get, /getLatestSeoSnapshots/)
  assert.doesNotMatch(get, /createWebmasterClient|createMetrikaClient|runSeoObserver|ConfigFromEnv|fetch\(/)
  const post = route.slice(route.indexOf('export async function POST'))
  assert.match(post, /runSeoObserver/)
  assert.doesNotMatch(route, /cron|schedule|setInterval/i)
})

test('secrets: tokens stay in server env — not returned, not stored in snapshots, not logged', () => {
  const route = readFileSync(new URL('../app/api/seo-observer/route.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(route, /console\.(log|error)\([^)]*(token|config|process\.env)/i)
  for (const call of route.match(/NextResponse\.json\(.*\)/g) ?? []) assert.doesNotMatch(call, /Config|token|process\.env/i, call) // no config or token enters a response
  const store = readFileSync(new URL('./seo-observer.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(store, /process\.env|webmasterConfig|metrikaConfig/) // the service never touches credentials; only ready clients are injected
  const ui = readFileSync(new URL('../components/sections/seo-observer.tsx', import.meta.url), 'utf8')
  assert.equal((ui.match(/method: 'POST'/g) ?? []).length, 1)
  assert.ok(ui.indexOf("method: 'POST'") > ui.indexOf('async function fetchData')) // the only POST lives in the button handler, never in a mount effect
  assert.match(ui, /onClick=\{fetchData\}/)
})
