import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyzePage, checkProjectHealth, MAX_PAGES_PER_PROJECT, pageIssues, robotsDisallowsAll, summarize, type PageCheck } from './seo-health.ts'
import { resolveSitemapUrl } from './sitemap.ts'

const H = (map: Record<string, string> = {}) => ({ get: (k: string) => map[k.toLowerCase()] ?? null })
const page = (over: Partial<PageCheck> = {}): PageCheck => ({
  url: 'https://x.ru/a', httpStatus: 200, canonical: 'https://x.ru/a', indexing: 'index', title: 'T', h1: 'H', redirectTo: null, inSitemap: true, ...over,
})
const codes = (p: PageCheck) => pageIssues(p).map((i) => `${i.severity}:${i.code}`)

// ---- sitemap source of truth -----------------------------------------------------------------------------------

test('resolveSitemapUrl: project.sitemap_url wins; domain + /sitemap.xml only as the single fallback; junk → null', () => {
  assert.equal(resolveSitemapUrl({ domain: 'https://x.ru', sitemap_url: 'https://x.ru/custom-map.xml' }), 'https://x.ru/custom-map.xml')
  assert.equal(resolveSitemapUrl({ domain: 'https://x.ru/', sitemap_url: '' }), 'https://x.ru/sitemap.xml')
  assert.equal(resolveSitemapUrl({ domain: 'https://x.ru', sitemap_url: null }), 'https://x.ru/sitemap.xml')
  assert.equal(resolveSitemapUrl({ domain: '', sitemap_url: '' }), null)
  assert.equal(resolveSitemapUrl({ domain: 'x.ru', sitemap_url: '' }), null)
  assert.equal(resolveSitemapUrl({ domain: 'https://x.ru', sitemap_url: 'ftp://x.ru/s.xml' }), null)
})

test('Pages sync and Technical SEO share one sitemap reader and one resolver (no second implementation)', () => {
  const sync = readFileSync(new URL('../app/api/pages/sync/route.ts', import.meta.url), 'utf8')
  const health = readFileSync(new URL('./seo-health.ts', import.meta.url), 'utf8')
  assert.match(sync, /resolveSitemapUrl\(project\)/)
  assert.match(health, /resolveSitemapUrl\(project\)/)
  assert.match(health, /readSitemap\(/)
  assert.doesNotMatch(health, /'\/sitemap\.xml'|countLocs|<loc>/)
})

// ---- robots ------------------------------------------------------------------------------------------------------

test('robots.txt: Disallow: / for all agents is detected; partial rules, other agents and Allow: / are not', () => {
  assert.equal(robotsDisallowsAll('User-agent: *\nDisallow: /'), true)
  assert.equal(robotsDisallowsAll('user-agent: *\r\ndisallow: /  # all\r\n'), true)
  assert.equal(robotsDisallowsAll('User-agent: *\nDisallow: /admin\nDisallow: /api/'), false)
  assert.equal(robotsDisallowsAll('User-agent: *\nDisallow:'), false)
  assert.equal(robotsDisallowsAll('User-agent: BadBot\nDisallow: /'), false)
  assert.equal(robotsDisallowsAll('User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private'), false)
  assert.equal(robotsDisallowsAll('User-agent: *\nAllow: /\nDisallow: /'), false)
  assert.equal(robotsDisallowsAll('User-agent: Yandex\nUser-agent: *\nDisallow: /'), true)
  assert.equal(robotsDisallowsAll('Sitemap: https://x.ru/sitemap.xml'), false)
})

// ---- page analysis + severity ------------------------------------------------------------------------------------

test('analyzePage reads canonical (relative resolved), robots meta / X-Robots-Tag, title and H1', () => {
  const html = '<html><head><title> My title </title><link rel="canonical" href="/a/"><meta name="robots" content="index, follow"></head><body><h1> Head </h1></body></html>'
  const p = analyzePage('https://x.ru/a', 200, html, H())
  assert.deepEqual([p.title, p.h1, p.canonical, p.indexing], ['My title', 'Head', 'https://x.ru/a', 'index'])
  assert.equal(analyzePage('https://x.ru/a', 200, '<meta name="robots" content="NOINDEX,nofollow">', H()).indexing, 'noindex')
  assert.equal(analyzePage('https://x.ru/a', 200, '<meta name="yandex" content="noindex">', H()).indexing, 'noindex')
  assert.equal(analyzePage('https://x.ru/a', 200, '<p>x</p>', H({ 'x-robots-tag': 'noindex, nofollow' })).indexing, 'noindex')
  assert.equal(analyzePage('https://x.ru/a', 200, '<meta name="robots" content="index">', H()).indexing, 'index')
  assert.equal(analyzePage('https://x.ru/a', 301, '', H({ location: '/b' })).redirectTo, '/b')
})

test('severity: a healthy page has no issues', () => {
  assert.deepEqual(pageIssues(page()), [])
  assert.deepEqual(pageIssues(page({ canonical: 'https://x.ru/a/' })), []) // trailing slash is not a mismatch
  assert.deepEqual(summarize([]), { errors: 0, warnings: 0, overall: 'OK' })
})

test('severity ERROR: 4xx/5xx, unreachable, noindex in the sitemap', () => {
  assert.deepEqual(codes(page({ httpStatus: 404 })), ['ERROR:page_http_error'])
  assert.deepEqual(codes(page({ httpStatus: 503 })), ['ERROR:page_http_error'])
  assert.deepEqual(codes(page({ httpStatus: null })), ['ERROR:page_unreachable'])
  assert.deepEqual(codes(page({ indexing: 'noindex' })), ['ERROR:noindex_in_sitemap'])
})

test('severity WARNING: redirect, canonical missing / different, title missing, H1 missing', () => {
  assert.deepEqual(codes(page({ httpStatus: 301, redirectTo: '/b' })), ['WARNING:page_redirect'])
  assert.deepEqual(codes(page({ canonical: null })), ['WARNING:canonical_missing'])
  assert.deepEqual(codes(page({ canonical: 'https://x.ru/other' })), ['WARNING:canonical_mismatch'])
  assert.deepEqual(codes(page({ title: null })), ['WARNING:title_missing'])
  assert.deepEqual(codes(page({ h1: null })), ['WARNING:h1_missing'])
  assert.deepEqual(summarize(pageIssues(page({ h1: null, title: null }))), { errors: 0, warnings: 2, overall: 'Warning' })
  assert.equal(summarize([...pageIssues(page({ httpStatus: 500 })), ...pageIssues(page({ h1: null }))]).overall, 'Error')
})

// ---- pipeline with scripted network -------------------------------------------------------------------------------

type Answer = { status?: number; body?: string; headers?: Record<string, string> } | 'fail'
async function withNetwork<T>(routes: Record<string, Answer>, fn: (calls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url)
    calls.push(u)
    const a = routes[u] ?? { status: 404, body: 'nf' }
    if (a === 'fail') throw new Error('network')
    return new Response(a.body ?? '', { status: a.status ?? 200, headers: a.headers })
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}
const goodPage = (path: string) => `<html><head><title>T ${path}</title><link rel="canonical" href="https://x.ru${path}"></head><body><h1>H</h1></body></html>`
const smap = (...paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>https://x.ru${p}</loc></url>`).join('')}</urlset>`
const PROJECT = { id: 1, name: 'X', domain: 'https://x.ru', sitemap_url: 'https://x.ru/sitemap.xml' }

test('healthy project: site OK, robots OK, sitemap OK with the URL count, every page row has status/canonical/index/title/H1, issues = 0', async () => {
  const paths = ['/', '/a', '/b', '/c']
  const routes: Record<string, Answer> = {
    'https://x.ru': { body: 'ok' },
    'https://x.ru/robots.txt': { body: 'User-agent: *\nDisallow: /api/\nSitemap: https://x.ru/sitemap.xml' },
    'https://x.ru/sitemap.xml': { body: smap(...paths) },
    ...Object.fromEntries(paths.map((p) => [`https://x.ru${p}`, { body: goodPage(p === '/' ? '' : p) }])),
  }
  const h = await withNetwork(routes, () => checkProjectHealth(PROJECT))
  assert.deepEqual([h.site.status, h.robots.status, h.sitemap.status, h.sitemap.urlCount], ['OK', 'OK', 'OK', 4])
  assert.equal(h.pages.length, 4)
  for (const p of h.pages) assert.deepEqual([p.httpStatus, p.indexing, !!p.title, !!p.h1, !!p.canonical, p.inSitemap], [200, 'index', true, true, true, true])
  assert.deepEqual([h.errors, h.warnings, h.overall, h.issues], [0, 0, 'OK', []])
})

test('project.sitemap_url is the source: the custom URL is fetched, /sitemap.xml is not guessed', async () => {
  const routes: Record<string, Answer> = { 'https://x.ru': {}, 'https://x.ru/robots.txt': { body: 'User-agent: *\nDisallow:' }, 'https://x.ru/map/custom.xml': { body: smap('/a') }, 'https://x.ru/a': { body: goodPage('/a') } }
  const calls = await withNetwork(routes, async (c) => {
    const h = await checkProjectHealth({ ...PROJECT, sitemap_url: 'https://x.ru/map/custom.xml' })
    assert.equal(h.sitemap.urlCount, 1)
    return c
  })
  assert.ok(calls.includes('https://x.ru/map/custom.xml'))
  assert.ok(!calls.includes('https://x.ru/sitemap.xml'))
})

test('sitemap missing: a clear ERROR, no page fetches, the check does not throw', async () => {
  const h = await withNetwork({ 'https://x.ru': {}, 'https://x.ru/robots.txt': { body: 'User-agent: *\nDisallow:' }, 'https://x.ru/sitemap.xml': { status: 404 } }, () => checkProjectHealth(PROJECT))
  assert.deepEqual([h.sitemap.status, h.sitemap.httpStatus, h.pages.length], ['Missing', 404, 0])
  assert.deepEqual(h.issues.map((i) => `${i.severity}:${i.code}`), ['ERROR:sitemap_missing'])
  assert.equal(h.overall, 'Error')
})

test('sitemap unreadable (not XML) and unreachable are ERRORs, not crashes', async () => {
  const notXml = await withNetwork({ 'https://x.ru': {}, 'https://x.ru/robots.txt': { body: '' }, 'https://x.ru/sitemap.xml': { body: '<html>oops</html>' } }, () => checkProjectHealth(PROJECT))
  assert.deepEqual([notXml.sitemap.status, notXml.sitemap.urlCount], ['Error', null])
  const down = await withNetwork({ 'https://x.ru': 'fail', 'https://x.ru/robots.txt': 'fail', 'https://x.ru/sitemap.xml': 'fail' }, () => checkProjectHealth(PROJECT))
  assert.deepEqual(down.issues.map((i) => i.code).sort(), ['robots_unreadable', 'site_unavailable', 'sitemap_unreadable'])
  assert.equal(down.overall, 'Error')
})

test('robots.txt missing is a WARNING (not an ERROR); Disallow: / is an ERROR', async () => {
  const base: Record<string, Answer> = { 'https://x.ru': {}, 'https://x.ru/sitemap.xml': { body: smap('/a') }, 'https://x.ru/a': { body: goodPage('/a') } }
  const missing = await withNetwork({ ...base, 'https://x.ru/robots.txt': { status: 404 } }, () => checkProjectHealth(PROJECT))
  assert.deepEqual([missing.robots.status, missing.errors, missing.warnings, missing.overall], ['Missing', 0, 1, 'Warning'])
  assert.deepEqual(missing.issues.map((i) => i.code), ['robots_missing'])
  const closed = await withNetwork({ ...base, 'https://x.ru/robots.txt': { body: 'User-agent: *\nDisallow: /' } }, () => checkProjectHealth(PROJECT))
  assert.deepEqual([closed.robots.status, closed.robots.disallowAll, closed.overall], ['Error', true, 'Error'])
})

test('problem pages are listed with their URL: 404, noindex, redirect, missing canonical/title/H1', async () => {
  const routes: Record<string, Answer> = {
    'https://x.ru': {}, 'https://x.ru/robots.txt': { body: 'User-agent: *\nDisallow:' },
    'https://x.ru/sitemap.xml': { body: smap('/ok', '/gone', '/hidden', '/moved', '/bare') },
    'https://x.ru/ok': { body: goodPage('/ok') },
    'https://x.ru/gone': { status: 404 },
    'https://x.ru/hidden': { body: '<title>T</title><meta name="robots" content="noindex"><link rel="canonical" href="https://x.ru/hidden"><h1>H</h1>' },
    'https://x.ru/moved': { status: 301, headers: { location: 'https://x.ru/new' } },
    'https://x.ru/bare': { body: '<p>nothing</p>' },
  }
  const h = await withNetwork(routes, () => checkProjectHealth(PROJECT))
  const byUrl = (u: string) => h.issues.filter((i) => i.url === `https://x.ru${u}`).map((i) => `${i.severity}:${i.code}`)
  assert.deepEqual(byUrl('/ok'), [])
  assert.deepEqual(byUrl('/gone'), ['ERROR:page_http_error'])
  assert.deepEqual(byUrl('/hidden'), ['ERROR:noindex_in_sitemap'])
  assert.deepEqual(byUrl('/moved'), ['WARNING:page_redirect'])
  assert.deepEqual(byUrl('/bare'), ['WARNING:canonical_missing', 'WARNING:title_missing', 'WARNING:h1_missing'])
  assert.deepEqual([h.errors, h.warnings, h.overall], [2, 4, 'Error'])
})

test('a large sitemap is capped: the count is real, only the first URLs are fetched, pagesTruncated is set', async () => {
  const paths = Array.from({ length: MAX_PAGES_PER_PROJECT + 5 }, (_, i) => `/p${i}`)
  const routes: Record<string, Answer> = { 'https://x.ru': {}, 'https://x.ru/robots.txt': { body: '' }, 'https://x.ru/sitemap.xml': { body: smap(...paths) } }
  for (const p of paths) routes[`https://x.ru${p}`] = { body: goodPage(p) }
  const h = await withNetwork(routes, () => checkProjectHealth(PROJECT))
  assert.deepEqual([h.sitemap.urlCount, h.pages.length, h.pagesTruncated], [MAX_PAGES_PER_PROJECT + 5, MAX_PAGES_PER_PROJECT, true])
})

test('route: all projects with a domain, no allow-list, sitemap_url is selected, a failing project does not break the batch', () => {
  const route = readFileSync(new URL('../app/api/seo-health/route.ts', import.meta.url), 'utf8')
  assert.match(route, /listProjects\(pool\)/) // the shared registry: active projects (with sitemap_url), no own SQL
  assert.doesNotMatch(route, /driveset/i)
  assert.match(route, /check_failed/)
})

test('screen: no automatic preflight on mount — the check starts only from the button', () => {
  const ui = readFileSync(new URL('../components/sections/seo-health.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(ui, /useEffect/)
  assert.equal([...ui.matchAll(/fetch\('\/api\/seo-health'\)/g)].length, 1)
  assert.match(ui, /onClick=\{runCheck\}/)
})
