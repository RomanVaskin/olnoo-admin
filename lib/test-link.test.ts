import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildTestUrl, normalizeProjectDomain, parseTtlMinutes, resolveTestProject, secretsFor, TEST_SESSION_PROJECTS } from './test-session-config.ts'
import { createTestLink } from './test-link.ts'
import { verifyTestSessionToken } from './test-session-token.ts'

const SECRET = 'c'.repeat(64)
const ENV = { OLNOO_TEST_SECRET_DRIVESET: SECRET }
const NOW = Date.parse('2026-10-05T12:00:00Z')

function loader(domain: string | null) {
  const calls: string[] = []
  return { calls, loadDomain: async (slug: string) => (calls.push(slug), domain) }
}
const run = (body: unknown, over: Partial<Parameters<typeof createTestLink>[0]> = {}, domain: string | null = 'https://driveset.ru') =>
  createTestLink({ body, env: ENV, now: NOW, loadDomain: loader(domain).loadDomain, ...over })
const tokenOf = (url: string) => new URL(url).searchParams.get('t') as string

// ---- config ----------------------------------------------------------------------------------------

test('config: driveset only, its own secret variable and key version, default 120 min, max 720 min', () => {
  assert.deepEqual(Object.keys(TEST_SESSION_PROJECTS), ['driveset'])
  const c = resolveTestProject('driveset')!
  assert.deepEqual([c.keys, c.issueKeyVersion, c.defaultTtlMinutes, c.maxTtlMinutes, c.urlPath], [[{ version: 1, env: 'OLNOO_TEST_SECRET_DRIVESET' }], 1, 120, 720, '/olnoo-test'])
  for (const slug of ['olnoo', 'all', '', '__proto__', 'constructor', 'toString', 5, null, undefined]) assert.equal(resolveTestProject(slug), null)
  assert.deepEqual(secretsFor(c, { OLNOO_TEST_SECRET_DRIVESET: ` ${SECRET} `, OLNOO_TEST_SECRET_OTHER: 'x' }), { 1: SECRET }) // only the project's own variable, trimmed
  assert.deepEqual(secretsFor(c, {}), { 1: undefined })
  assert.deepEqual(secretsFor(c, { OLNOO_TEST_SECRET_DRIVESET: '  ' }), { 1: undefined })
})

test('ttl: default 120, integer 1..720 accepted; 0, negative, fractional, string, null, > 720 rejected', () => {
  const c = resolveTestProject('driveset')!
  assert.deepEqual(parseTtlMinutes(undefined, c), { ok: true, minutes: 120 })
  for (const m of [1, 30, 720]) assert.deepEqual(parseTtlMinutes(m, c), { ok: true, minutes: m })
  for (const bad of [0, -5, 1.5, 721, 10_000, '120', null, NaN, Infinity, true, [], {}]) assert.deepEqual(parseTtlMinutes(bad, c), { ok: false }, String(bad))
})

test('domain normalisation: bare host or http(s) host with an optional slash; everything else is rejected', () => {
  for (const [input, host] of [['driveset.ru', 'driveset.ru'], ['https://driveset.ru', 'driveset.ru'], ['https://DriveSet.RU/', 'driveset.ru'], ['http://driveset.ru', 'driveset.ru'], ['  https://insurance.olnoo.com  ', 'insurance.olnoo.com']] as const) {
    assert.equal(normalizeProjectDomain(input), host, input)
  }
  for (const bad of ['', 'https://', 'https://user:pw@driveset.ru', 'https://driveset.ru:8080', 'https://driveset.ru/path', 'https://driveset.ru?x=1', 'https://driveset.ru#h', 'driveset', '127.0.0.1', 'https://a b.ru', 'ftp://driveset.ru', 'javascript:alert(1)', 'https://driveset_x.ru', 'https://-bad.ru', null, undefined, 5]) {
    assert.equal(normalizeProjectDomain(bad), null, String(bad))
  }
  assert.equal(buildTestUrl('driveset.ru', '/olnoo-test', 'tok.en'), 'https://driveset.ru/olnoo-test?t=tok.en')
})

// ---- the generator ----------------------------------------------------------------------------------

test('valid request: 200 with url, expiresAt, sessionId — the token only inside the url', async () => {
  const r = await run({ project: 'driveset' })
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body).sort(), ['expiresAt', 'project', 'sessionId', 'url'])
  assert.equal(r.body.project, 'driveset')
  const url = new URL(r.body.url as string)
  assert.deepEqual([url.origin, url.pathname, [...url.searchParams.keys()]], ['https://driveset.ru', '/olnoo-test', ['t']])
  assert.equal(r.body.expiresAt, '2026-10-05T14:00:00.000Z') // default 2 hours from the injected clock
  assert.ok(!JSON.stringify(r.body).replace(r.body.url as string, '').includes(tokenOf(r.body.url as string))) // token not duplicated
  const v = verifyTestSessionToken(tokenOf(r.body.url as string), { project: 'driveset', secrets: { 1: SECRET }, now: NOW + 1000 })
  assert.ok(v.valid)
  assert.equal(v.sessionId, r.body.sessionId)
  assert.equal(v.expiresAt.toISOString(), r.body.expiresAt)
})

test('ttlMinutes is honoured (1, 720) and bounds are enforced with a 400', async () => {
  assert.equal((await run({ project: 'driveset', ttlMinutes: 30 })).body.expiresAt, '2026-10-05T12:30:00.000Z')
  assert.equal((await run({ project: 'driveset', ttlMinutes: 720 })).body.expiresAt, '2026-10-06T00:00:00.000Z')
  for (const ttlMinutes of [721, 0, -1, 1.5, '120', null, NaN]) assert.equal((await run({ project: 'driveset', ttlMinutes })).status, 400, String(ttlMinutes))
})

test('invalid bodies are 400; unknown project is 404; a missing secret is 503 and never reveals a value', async () => {
  for (const body of [null, undefined, 'x', 5, [], {}, { project: 5 }, { project: '' }, { project: 'driveset', url: 'https://evil.example' }, { project: 'driveset', ttlMinutes: 5, extra: true }]) {
    assert.equal((await run(body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await run({ project: 'olnoo' })).status, 404)
  assert.equal((await run({ project: '__proto__' })).status, 404)
  const missing = await run({ project: 'driveset' }, { env: {} })
  assert.equal(missing.status, 503)
  assert.deepEqual(missing.body, { error: { kind: 'not_configured', message: 'test links are not configured for this project' } })
  assert.equal((await run({ project: 'driveset' }, { env: { OLNOO_TEST_SECRET_DRIVESET: 'too-short' } })).status, 503) // a weak secret is not accepted
  const out = JSON.stringify([missing, await run({ project: 'olnoo' }), await run(null)])
  assert.ok(!out.includes(SECRET))
})

test('two links for the same project differ (random sid); the project domain comes from the database value, never from the client', async () => {
  const a = await run({ project: 'driveset' })
  const b = await run({ project: 'driveset' })
  assert.notEqual(a.body.sessionId, b.body.sessionId)
  assert.notEqual(a.body.url, b.body.url)
  assert.equal(new URL((await run({ project: 'driveset' }, {}, 'driveset.ru')).body.url as string).origin, 'https://driveset.ru') // a bare stored host works
  const bad = await run({ project: 'driveset' }, {}, 'https://driveset.ru/with/path')
  assert.equal(bad.status, 500)
  assert.equal((bad.body.error as { kind: string }).kind, 'domain_invalid')
  assert.equal((await run({ project: 'driveset' }, {}, null)).status, 404) // configured, but no such project row
})

test('the generator only READS the project domain: one lookup, no write helper is even reachable', async () => {
  const l = loader('https://driveset.ru')
  await createTestLink({ body: { project: 'driveset' }, env: ENV, now: NOW, loadDomain: l.loadDomain })
  assert.deepEqual(l.calls, ['driveset'])
  for (const file of ['./test-link.ts', './test-session-config.ts', './test-session-token.ts', '../app/api/test-links/route.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)?\s*\w*/, file) // no SQL write
    assert.doesNotMatch(src, /console\.(log|info|warn|error|debug)/, file) // nothing is logged
  }
})

test('route: POST only, Cache-Control no-store, the only SQL is a SELECT of the domain, nothing stored', () => {
  const route = readFileSync(new URL('../app/api/test-links/route.ts', import.meta.url), 'utf8')
  assert.deepEqual([...route.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]), ['POST'])
  assert.match(route, /'Cache-Control': 'no-store'/)
  assert.match(route, /Pragma: 'no-cache'/)
  const sql = [...route.matchAll(/pool\.query[^(]*\(\s*'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(sql, ['SELECT domain FROM projects WHERE slug = $1'])
  assert.doesNotMatch(route, /localStorage|writeFile|cookies\(|headers\(\)\.set/)
})
