import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildTestUrl, normalizeProjectDomain, resolveTestProject, TEST_LINK_PROJECTS } from './test-link-config.ts'
import { createTestLink } from './test-link.ts'
import { classifyLead, matchesTestUtm, TEST_UTM_CONTENT, TEST_UTM_MEDIUM, TEST_UTM_SOURCE } from './traffic-class.ts'

function loader(domain: string | null) {
  const calls: string[] = []
  return { calls, loadDomain: async (slug: string) => (calls.push(slug), domain) }
}
const run = (body: unknown, domain: string | null = 'https://driveset.ru', over: Partial<Parameters<typeof createTestLink>[0]> = {}) =>
  createTestLink({ body, loadDomain: loader(domain).loadDomain, ...over })

test('config: driveset only (explicit allow-list); anything else is not a test-link project', () => {
  assert.deepEqual(Object.keys(TEST_LINK_PROJECTS), ['driveset'])
  assert.deepEqual(resolveTestProject('driveset'), { slug: 'driveset', urlPath: '/' })
  for (const slug of ['olnoo', 'all', '', '__proto__', 'constructor', 'toString', 5, null, undefined]) assert.equal(resolveTestProject(slug), null)
})

test('domain normalisation: bare host or http(s) host with an optional slash; everything else is rejected', () => {
  for (const [input, host] of [['driveset.ru', 'driveset.ru'], ['https://driveset.ru', 'driveset.ru'], ['https://DriveSet.RU/', 'driveset.ru'], ['http://driveset.ru', 'driveset.ru'], ['  https://insurance.olnoo.com  ', 'insurance.olnoo.com']] as const) {
    assert.equal(normalizeProjectDomain(input), host, input)
  }
  for (const bad of ['', 'https://', 'https://user:pw@driveset.ru', 'https://driveset.ru:8080', 'https://driveset.ru/path', 'https://driveset.ru?x=1', 'https://driveset.ru#h', 'driveset', '127.0.0.1', 'https://a b.ru', 'ftp://driveset.ru', 'javascript:alert(1)', 'https://driveset_x.ru', 'https://-bad.ru', null, undefined, 5]) {
    assert.equal(normalizeProjectDomain(bad), null, String(bad))
  }
})

test('the link is a plain UTM URL: utm_source=olnoo&utm_medium=test&utm_content=olnoo_test&utm_term=<sessionId> — no token, no signature, no expiry', async () => {
  const r = await run({ project: 'driveset' }, 'https://driveset.ru', { randomBytes: (n) => Buffer.alloc(n, 1) })
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body).sort(), ['expiresAt', 'project', 'sessionId', 'url'])
  assert.equal(r.body.expiresAt, null)
  assert.equal(r.body.sessionId, Buffer.alloc(9, 1).toString('base64url'))
  assert.equal(r.body.url, `https://driveset.ru/?utm_source=olnoo&utm_medium=test&utm_content=olnoo_test&utm_term=${r.body.sessionId}`)
  const url = new URL(r.body.url as string)
  assert.deepEqual([url.origin, url.pathname], ['https://driveset.ru', '/'])
  assert.deepEqual([...url.searchParams.keys()], ['utm_source', 'utm_medium', 'utm_content', 'utm_term'])
  assert.doesNotMatch(r.body.url as string, /olnoo-t1|[?&]t=|token|sig/i)
  assert.equal(buildTestUrl('driveset.ru', '/', 'abc'), 'https://driveset.ru/?utm_source=olnoo&utm_medium=test&utm_content=olnoo_test&utm_term=abc')
})

test('the generated link is exactly what the classifier calls TEST (one definition of the test UTM)', async () => {
  const r = await run({ project: 'driveset' })
  const q = new URL(r.body.url as string).searchParams
  assert.deepEqual([q.get('utm_source'), q.get('utm_medium'), q.get('utm_content')], [TEST_UTM_SOURCE, TEST_UTM_MEDIUM, TEST_UTM_CONTENT])
  assert.equal(matchesTestUtm(q.get('utm_source'), q.get('utm_medium')), true)
  assert.deepEqual(classifyLead({ project: 'driveset', intake: 'inbound_api', utmSource: q.get('utm_source'), utmMedium: q.get('utm_medium'), utmContent: q.get('utm_content'), utmTerm: q.get('utm_term'), env: { DRIVESET_TEST_CLASSIFICATION_SINCE: '2020-01-01T00:00:00Z' } }), { auto: 'TEST', reason: 'test_utm' })
})

test('every link gets a different session id; the domain comes from the database value, never from the client', async () => {
  const a = await run({ project: 'driveset' })
  const b = await run({ project: 'driveset' })
  assert.notEqual(a.body.sessionId, b.body.sessionId)
  assert.equal(new URL((await run({ project: 'driveset' }, 'driveset.ru')).body.url as string).origin, 'https://driveset.ru') // a bare stored host works
  const bad = await run({ project: 'driveset' }, 'https://driveset.ru/with/path')
  assert.deepEqual([bad.status, (bad.body.error as { kind: string }).kind], [500, 'domain_invalid'])
  assert.equal((await run({ project: 'driveset' }, null)).status, 404) // configured, but no such project row
})

test('invalid bodies are 400 (including a client-supplied url); unknown project is 404; the legacy ttlMinutes is validated but has no effect', async () => {
  for (const body of [null, undefined, 'x', 5, [], {}, { project: 5 }, { project: '' }, { project: 'driveset', url: 'https://evil.example' }, { project: 'driveset', utm_source: 'x' }]) {
    assert.equal((await run(body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await run({ project: 'olnoo' })).status, 404)
  assert.equal((await run({ project: '__proto__' })).status, 404)
  for (const ttlMinutes of [0, -1, 1.5, 721, '120', null, NaN]) assert.equal((await run({ project: 'driveset', ttlMinutes })).status, 400, String(ttlMinutes))
  const withTtl = await run({ project: 'driveset', ttlMinutes: 30 })
  assert.equal(withTtl.status, 200)
  assert.equal(withTtl.body.expiresAt, null)
})

test('read-only and secret-free: one lookup of the domain, no write, no env, no crypto signing, no logging', async () => {
  const l = loader('https://driveset.ru')
  await createTestLink({ body: { project: 'driveset' }, loadDomain: l.loadDomain })
  assert.deepEqual(l.calls, ['driveset'])
  for (const file of ['./test-link.ts', './test-link-config.ts', '../app/api/test-links/route.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)?\s*\w*/, file)
    assert.doesNotMatch(src, /console\.(log|info|warn|error|debug)/, file)
    assert.doesNotMatch(src, /process\.env|createHmac|OLNOO_TEST_SECRET|test-session-token/, file)
  }
})

test('route: POST only, Cache-Control no-store, the only SQL is a SELECT of the domain', () => {
  const route = readFileSync(new URL('../app/api/test-links/route.ts', import.meta.url), 'utf8')
  assert.deepEqual([...route.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]), ['POST'])
  assert.match(route, /'Cache-Control': 'no-store'/)
  assert.deepEqual([...route.matchAll(/pool\.query[^(]*\(\s*'([^']+)'/g)].map((m) => m[1]), ['SELECT domain FROM projects WHERE slug = $1'])
})
