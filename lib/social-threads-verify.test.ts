import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyThreadsAccountToken } from './social-threads-verify.ts'

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

test('a valid token resolves the Threads user id and username', async () => {
  const result = await withFetch(
    () => jsonResponse({ id: '9999999999', username: 'olnoo_ai' }),
    () => verifyThreadsAccountToken('good-token'),
  )
  assert.deepEqual(result, { ok: true, identity: { userId: '9999999999', username: 'olnoo_ai' } })
})

test('a response with no id is rejected, not guessed', async () => {
  const result = await withFetch(
    () => jsonResponse({ username: 'someone' }),
    () => verifyThreadsAccountToken('bad-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && /user id/i.test(result.error))
})

test('a Threads API error (e.g. invalid/revoked token) is surfaced, not silently treated as connected', async () => {
  const result = await withFetch(
    () => jsonResponse({ error: { message: 'Invalid OAuth access token.' } }, 400),
    () => verifyThreadsAccountToken('revoked-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('Invalid OAuth access token'))
})

test('a network failure is surfaced as an error, not thrown past the caller', async () => {
  const result = await withFetch(
    () => new Error('getaddrinfo ENOTFOUND graph.threads.net'),
    () => verifyThreadsAccountToken('any-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('ENOTFOUND'))
})
