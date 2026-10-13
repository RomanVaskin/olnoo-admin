import test from 'node:test'
import assert from 'node:assert/strict'
import { refreshInstagramLongLivedToken, refreshThreadsLongLivedToken } from './social-meta-token-refresh.ts'

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

test('Instagram: a successful refresh returns the new token and an expiry ~60 days out, and uses ig_refresh_token', async () => {
  let calledUrl = ''
  const before = Date.now()
  const result = await withFetch(
    (url) => {
      calledUrl = url
      return jsonResponse({ access_token: 'new-token', token_type: 'bearer', expires_in: 5183944 })
    },
    () => refreshInstagramLongLivedToken('old-token'),
  )
  assert.ok(calledUrl.includes('grant_type=ig_refresh_token'))
  assert.ok(calledUrl.includes('access_token=old-token'))
  assert.ok(result.ok)
  assert.ok(result.ok && result.token === 'new-token')
  assert.ok(result.ok && result.expiresAt.getTime() > before + 5183944 * 1000 - 5000)
})

test('Instagram: a token too young to refresh (or any API rejection) is surfaced as an error, not thrown', async () => {
  const result = await withFetch(
    () => jsonResponse({ error: { message: 'This access token is not eligible to be refreshed at this time.' } }, 400),
    () => refreshInstagramLongLivedToken('young-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && /eligible to be refreshed/.test(result.error))
})

test('Instagram: a network failure is surfaced as an error', async () => {
  const result = await withFetch(
    () => new Error('getaddrinfo ENOTFOUND graph.instagram.com'),
    () => refreshInstagramLongLivedToken('any-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('ENOTFOUND'))
})

test('Threads: a successful refresh returns the new token and uses th_refresh_token', async () => {
  let calledUrl = ''
  const result = await withFetch(
    (url) => {
      calledUrl = url
      return jsonResponse({ access_token: 'new-threads-token', token_type: 'bearer', expires_in: 5184000 })
    },
    () => refreshThreadsLongLivedToken('old-token'),
  )
  assert.ok(calledUrl.includes('grant_type=th_refresh_token'))
  assert.ok(result.ok)
  assert.ok(result.ok && result.token === 'new-threads-token')
})

test('Threads: an expired/revoked token refresh failure is surfaced as an error, not thrown', async () => {
  const result = await withFetch(
    () => jsonResponse({ error: { message: 'Error validating access token: Session has expired.' } }, 400),
    () => refreshThreadsLongLivedToken('expired-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && /expired/.test(result.error))
})

test('a response missing access_token/expires_in is treated as a failure, never a silent success', async () => {
  const result = await withFetch(
    () => jsonResponse({ token_type: 'bearer' }),
    () => refreshInstagramLongLivedToken('any-token'),
  )
  assert.equal(result.ok, false)
})
