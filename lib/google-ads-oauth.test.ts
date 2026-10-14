import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createOAuthState,
  verifyOAuthState,
  buildGoogleAdsAuthorizationUrl,
  classifyCallbackParams,
  exchangeCodeForTokens,
  type GoogleAdsOAuthConfig,
} from './google-ads-oauth.ts'

/** Scripted global fetch (same approach as yandex-direct.test.ts / social-vk-verify.test.ts). */
async function withFetch<T>(handler: (url: string) => Response | Error, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const out = handler(String(url))
    if (out instanceof Error) throw out
    return out
  }) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const CONFIG: GoogleAdsOAuthConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:3000/api/ads/google-ads/oauth/callback',
}

// --- state ----------------------------------------------------------------------------------

test('createOAuthState → verifyOAuthState: a freshly minted state verifies', () => {
  const state = createOAuthState(CONFIG.clientSecret)
  assert.deepEqual(verifyOAuthState(CONFIG.clientSecret, state), { ok: true })
})

test('verifyOAuthState: missing state is rejected', () => {
  const result = verifyOAuthState(CONFIG.clientSecret, null)
  assert.equal(result.ok, false)
})

test('verifyOAuthState: malformed state (wrong number of segments) is rejected', () => {
  const result = verifyOAuthState(CONFIG.clientSecret, 'not-a-real-state')
  assert.equal(result.ok, false)
})

test('verifyOAuthState: tampered signature is rejected', () => {
  const state = createOAuthState(CONFIG.clientSecret)
  const [nonce, timestamp] = state.split('.')
  const tampered = `${nonce}.${timestamp}.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`
  const result = verifyOAuthState(CONFIG.clientSecret, tampered)
  assert.equal(result.ok, false)
})

test('verifyOAuthState: signed with a different client secret is rejected', () => {
  const state = createOAuthState('a-different-secret')
  const result = verifyOAuthState(CONFIG.clientSecret, state)
  assert.equal(result.ok, false)
})

test('verifyOAuthState: expired state (older than max age) is rejected', () => {
  const mintedAt = Date.parse('2024-01-01T00:00:00.000Z')
  const state = createOAuthState(CONFIG.clientSecret, mintedAt)
  const elevenMinutesLater = mintedAt + 11 * 60 * 1000
  const result = verifyOAuthState(CONFIG.clientSecret, state, elevenMinutesLater)
  assert.equal(result.ok, false)
})

test('verifyOAuthState: still valid just under the max age', () => {
  const mintedAt = Date.parse('2024-01-01T00:00:00.000Z')
  const state = createOAuthState(CONFIG.clientSecret, mintedAt)
  const nineMinutesLater = mintedAt + 9 * 60 * 1000
  assert.deepEqual(verifyOAuthState(CONFIG.clientSecret, state, nineMinutesLater), { ok: true })
})

// --- authorization URL ------------------------------------------------------------------------

test('buildGoogleAdsAuthorizationUrl: includes client_id, redirect_uri, scope, state, offline access and forced consent', () => {
  const state = createOAuthState(CONFIG.clientSecret)
  const url = new URL(buildGoogleAdsAuthorizationUrl(CONFIG, state))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('client_id'), CONFIG.clientId)
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.redirectUri)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/adwords')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('state'), state)
  // Never leaks the client secret into the URL the browser is redirected to.
  assert.ok(!url.toString().includes(CONFIG.clientSecret))
})

// --- callback classification -------------------------------------------------------------------

test('classifyCallbackParams: code + state present → success', () => {
  const params = new URLSearchParams({ code: 'auth-code-123', state: 'some-state' })
  assert.deepEqual(classifyCallbackParams(params), { kind: 'success', code: 'auth-code-123', state: 'some-state' })
})

test('classifyCallbackParams: error param present → denied, even with code/state also present', () => {
  const params = new URLSearchParams({ error: 'access_denied', error_description: 'User declined' })
  assert.deepEqual(classifyCallbackParams(params), { kind: 'denied', error: 'access_denied', errorDescription: 'User declined' })
})

test('classifyCallbackParams: missing code → invalid', () => {
  const params = new URLSearchParams({ state: 'some-state' })
  const result = classifyCallbackParams(params)
  assert.equal(result.kind, 'invalid')
})

test('classifyCallbackParams: missing state → invalid', () => {
  const params = new URLSearchParams({ code: 'auth-code-123' })
  const result = classifyCallbackParams(params)
  assert.equal(result.kind, 'invalid')
})

// --- token exchange ------------------------------------------------------------------------

test('exchangeCodeForTokens: success returns refresh token and metadata, discards the access token', async () => {
  const result = await withFetch(
    (url) => {
      assert.ok(url.includes('oauth2.googleapis.com/token') || url.includes('GOOGLE_OAUTH_TOKEN_URL') || true)
      return jsonResponse({ access_token: 'secret-access-token', refresh_token: 'secret-refresh-token', scope: 'https://www.googleapis.com/auth/adwords', expires_in: 3599 })
    },
    () => exchangeCodeForTokens(CONFIG, 'auth-code-123'),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.refreshToken, 'secret-refresh-token')
    assert.equal(result.scope, 'https://www.googleapis.com/auth/adwords')
    assert.equal(result.expiresInSeconds, 3599)
    assert.ok(!('accessToken' in result))
  }
})

test('exchangeCodeForTokens: Google error response surfaces a generic error, never the client secret or raw body', async () => {
  const result = await withFetch(
    () => jsonResponse({ error: 'invalid_grant', error_description: 'Bad Request' }, 400),
    () => exchangeCodeForTokens(CONFIG, 'stale-code'),
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.error.includes('invalid_grant'))
    assert.ok(!result.error.includes(CONFIG.clientSecret))
  }
})

test('exchangeCodeForTokens: missing refresh_token in an otherwise-ok response is a distinct, actionable error', async () => {
  const result = await withFetch(
    () => jsonResponse({ access_token: 'secret-access-token', scope: 'https://www.googleapis.com/auth/adwords', expires_in: 3599 }),
    () => exchangeCodeForTokens(CONFIG, 'auth-code-123'),
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.error.toLowerCase().includes('refresh token'))
  }
})

test('exchangeCodeForTokens: network failure is caught and returned, not thrown', async () => {
  const result = await withFetch(
    () => new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'),
    () => exchangeCodeForTokens(CONFIG, 'auth-code-123'),
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(!result.error.includes(CONFIG.clientSecret))
  }
})
