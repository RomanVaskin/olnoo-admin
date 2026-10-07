import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose'
import { MCP_QUERIES_SCOPE, parseOAuthConfig, protectedResourceMetadata, resourceMetadataUrl, verifyAccessToken, wwwAuthenticateChallenge } from './mcp-oauth.ts'
import { handleMcpRequest, SUMMARY_TOOL_NAME, type QueriesAccess } from './mcp-summary.ts'
import { QUERIES_TOOL_NAME } from './mcp-direct-queries.ts'

const ENV = { OLNOO_MCP_OAUTH_ISSUER: 'https://tenant.eu.auth0.com/', OLNOO_MCP_OAUTH_AUDIENCE: 'https://admin.olnoo.com/api/mcp' }
const CFG = parseOAuthConfig(ENV)!
const pair = generateKeyPair('RS256')
const keys: JWTVerifyGetKey = async () => (await pair).publicKey

const sign = async (over: { iss?: string; aud?: string; exp?: string | number; scope?: string | null; key?: CryptoKey; alg?: string; nbf?: number } = {}) => {
  const jwt = new SignJWT(over.scope === null ? {} : { scope: over.scope ?? `openid ${MCP_QUERIES_SCOPE}` })
    .setProtectedHeader({ alg: over.alg ?? 'RS256' })
    .setIssuer(over.iss ?? CFG.issuer)
    .setAudience(over.aud ?? CFG.audience)
    .setSubject('auth0|someone')
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '5m')
  return jwt.sign(over.key ?? (await pair).privateKey)
}
const bearer = (token: string) => new Request('http://x/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}` } })

// ---- config / metadata -------------------------------------------------------------------------------------------

test('config: needs an https issuer and https audience; the issuer gets a trailing slash; anything else disables OAuth', () => {
  assert.deepEqual(CFG, { issuer: 'https://tenant.eu.auth0.com/', audience: 'https://admin.olnoo.com/api/mcp' })
  assert.equal(parseOAuthConfig({ ...ENV, OLNOO_MCP_OAUTH_ISSUER: 'https://tenant.eu.auth0.com' })!.issuer, 'https://tenant.eu.auth0.com/')
  for (const bad of [{}, { ...ENV, OLNOO_MCP_OAUTH_ISSUER: '' }, { ...ENV, OLNOO_MCP_OAUTH_AUDIENCE: '' }, { ...ENV, OLNOO_MCP_OAUTH_ISSUER: 'http://tenant.eu.auth0.com/' }, { ...ENV, OLNOO_MCP_OAUTH_AUDIENCE: 'not a url' }, { ...ENV, OLNOO_MCP_OAUTH_AUDIENCE: 'https://x/api/mcp?a=1' }]) {
    assert.equal(parseOAuthConfig(bad as never), null)
  }
})

test('protected-resource metadata and challenge point ChatGPT at Auth0 and the right scope', () => {
  assert.deepEqual(protectedResourceMetadata(CFG), { resource: CFG.audience, authorization_servers: [CFG.issuer], scopes_supported: ['direct:read'], bearer_methods_supported: ['header'] })
  assert.equal(resourceMetadataUrl(CFG), 'https://admin.olnoo.com/.well-known/oauth-protected-resource')
  const c = wwwAuthenticateChallenge(CFG)
  assert.match(c, /^Bearer resource_metadata="https:\/\/admin\.olnoo\.com\/\.well-known\/oauth-protected-resource"/)
  assert.match(c, /scope="direct:read"/)
  assert.match(c, /error="insufficient_scope"/)
  assert.match(wwwAuthenticateChallenge(CFG, 'invalid_token'), /error="invalid_token"/)
})

// ---- token verification ------------------------------------------------------------------------------------------

test('a valid Auth0-style token (issuer, audience, expiry, scope) is accepted', async () => {
  assert.deepEqual(await verifyAccessToken(bearer(await sign()), CFG, keys), { ok: true })
  assert.deepEqual(await verifyAccessToken(bearer(await sign({ scope: 'direct:read' })), CFG, keys), { ok: true })
})

test('rejected: no header, empty token, other scheme, garbage, tampered, wrong issuer, wrong audience, expired, not yet valid', async () => {
  const reason = async (req: Request) => (await verifyAccessToken(req, CFG, keys)) as { ok: false; reason: string }
  assert.equal((await reason(new Request('http://x'))).reason, 'missing')
  assert.equal((await reason(new Request('http://x', { headers: { authorization: 'Bearer ' } }))).reason, 'missing')
  assert.equal((await reason(new Request('http://x', { headers: { authorization: 'Basic abc' } }))).reason, 'missing')
  assert.equal((await reason(bearer('not.a.jwt'))).reason, 'invalid')
  const good = await sign()
  assert.equal((await reason(bearer(good.slice(0, -4) + 'AAAA'))).reason, 'invalid')
  assert.equal((await reason(bearer(await sign({ iss: 'https://evil.example/' })))).reason, 'invalid')
  assert.equal((await reason(bearer(await sign({ aud: 'https://other.example/api' })))).reason, 'invalid')
  assert.equal((await reason(bearer(await sign({ exp: Math.floor(Date.now() / 1000) - 3600 })))).reason, 'invalid')
  const other = await generateKeyPair('RS256')
  assert.equal((await reason(bearer(await sign({ key: other.privateKey })))).reason, 'invalid') // signed by a different key
})

test('rejected: missing or wrong scope (insufficient_scope), and non-RS256 tokens', async () => {
  const reason = async (t: string) => (await verifyAccessToken(bearer(t), CFG, keys)) as { ok: false; reason: string }
  assert.equal((await reason(await sign({ scope: 'openid profile' }))).reason, 'insufficient_scope')
  assert.equal((await reason(await sign({ scope: null }))).reason, 'insufficient_scope')
  assert.equal((await reason(await sign({ scope: 'direct:readwrite' }))).reason, 'insufficient_scope') // exact match, not a prefix
  const hs = await new SignJWT({ scope: MCP_QUERIES_SCOPE }).setProtectedHeader({ alg: 'HS256' }).setIssuer(CFG.issuer).setAudience(CFG.audience).setExpirationTime('5m').sign(new TextEncoder().encode('x'.repeat(32)))
  assert.equal((await reason(hs)).reason, 'invalid')
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: CFG.issuer, aud: CFG.audience, scope: MCP_QUERIES_SCOPE, exp: 9999999999 })).toString('base64url')}.`
  assert.equal((await reason(none)).reason, 'invalid')
})

test('the default key source is the issuer JWKS (no keys are configured in env)', async () => {
  const jwk = await exportJWK((await pair).publicKey)
  assert.equal(jwk.kty, 'RSA')
  const src = readFileSync(new URL('./mcp-oauth.ts', import.meta.url), 'utf8')
  assert.match(src, /createRemoteJWKSet\(new URL\('\.well-known\/jwks\.json', issuer\)\)/)
})

// ---- MCP protocol: Mixed auth ------------------------------------------------------------------------------------

const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const rpc = (body: unknown, extra: Record<string, string> = {}) => new Request('http://x/api/mcp', { method: 'POST', headers: { ...HEADERS, ...extra }, body: JSON.stringify(body) })
const summary = async () => ({ summary: true }) as never

function access(state: 'ok' | 'denied' | 'unconfigured', loads: string[] = []): QueriesAccess {
  return {
    load: async (p) => (loads.push(p), { queries: [] } as never),
    authorize: async () => state,
    challenge: state === 'unconfigured' ? null : () => wwwAuthenticateChallenge(CFG),
    scope: MCP_QUERIES_SCOPE,
  }
}
const call = async (body: unknown, q?: QueriesAccess) => (await (await handleMcpRequest(rpc(body), summary, q)).json()) as any
const callTool = (name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

test('tools/list (no login needed): summary is noauth, queries is oauth2 with direct:read — at the top level and in _meta', async () => {
  const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, access('denied'))
  const [sum, q] = r.result.tools
  assert.deepEqual([sum.name, q.name], [SUMMARY_TOOL_NAME, QUERIES_TOOL_NAME])
  assert.deepEqual(sum.securitySchemes, [{ type: 'noauth' }])
  assert.deepEqual(q.securitySchemes, [{ type: 'oauth2', scopes: ['direct:read'] }])
  assert.deepEqual(sum._meta.securitySchemes, [{ type: 'noauth' }])
  assert.deepEqual(q._meta.securitySchemes, [{ type: 'oauth2', scopes: ['direct:read'] }])
  assert.equal(q.annotations.readOnlyHint, true)
})

test('get_driveset_summary works without any auth', async () => {
  const r = await call(callTool(SUMMARY_TOOL_NAME), access('denied'))
  assert.equal(r.result.isError, undefined)
  assert.equal(JSON.parse(r.result.content[0].text).summary, true)
})

test('get_direct_queries without a valid token: tool error with the OAuth challenge in _meta; the loader never runs', async () => {
  const loads: string[] = []
  const r = await call(callTool(QUERIES_TOOL_NAME, { period: 'today' }), access('denied', loads))
  assert.equal(r.result.isError, true)
  assert.deepEqual(r.result._meta['mcp/www_authenticate'], [wwwAuthenticateChallenge(CFG)])
  assert.deepEqual(loads, [])
  assert.ok(!JSON.stringify(r).includes('queries":'))
})

test('get_direct_queries with a valid token returns the data (period validated, default today)', async () => {
  const loads: string[] = []
  const r = await call(callTool(QUERIES_TOOL_NAME), access('ok', loads))
  assert.equal(r.result.isError, undefined)
  assert.deepEqual(loads, ['today'])
  const bad = await call(callTool(QUERIES_TOOL_NAME, { period: 'lastmonth' }), access('ok', loads))
  assert.ok(bad.error || bad.result?.isError)
  assert.deepEqual(loads, ['today'])
})

test('OAuth not configured: the queries tool answers a plain error without any challenge', async () => {
  const r = await call(callTool(QUERIES_TOOL_NAME), access('unconfigured'))
  assert.equal(r.result.isError, true)
  assert.equal(r.result._meta, undefined)
})

test('no static auth anywhere: no ?key=, no OLNOO_MCP_KEY, no Basic/query credentials in the MCP code or docs', () => {
  const files = ['./mcp-oauth.ts', './mcp-summary.ts', './mcp-direct-queries.ts', '../app/api/mcp/route.ts', '../app/.well-known/oauth-protected-resource/route.ts', '../OLNOO_PROJECT_MAP.md']
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /OLNOO_MCP_KEY|searchParams\.get\('key'\)|timingSafeEqual/, f)
    if (f.endsWith('.ts')) assert.doesNotMatch(src, /Basic /, f)
  }
  const route = readFileSync(new URL('../app/api/mcp/route.ts', import.meta.url), 'utf8')
  assert.deepEqual([...route.matchAll(/process\.env(?:\.(\w+))?/g)].map((m) => m[1] ?? 'ALL'), ['ALL']) // env goes only to parseOAuthConfig
  assert.match(route, /parseOAuthConfig\(process\.env\)/)
})
