import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyVkGroupToken } from './social-vk-verify.ts'

/** Scripted global fetch (same approach as yandex-direct.test.ts/fetch-retry.test.ts). */
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

test('a valid community token resolves the group id, screen name and name', async () => {
  const result = await withFetch(
    () => jsonResponse({ response: { groups: [{ id: 212959296, screen_name: 'olnoo_ai', name: 'OLNOO AI' }] } }),
    () => verifyVkGroupToken('good-token'),
  )
  assert.deepEqual(result, { ok: true, identity: { groupId: '212959296', screenName: 'olnoo_ai', name: 'OLNOO AI' } })
})

test('accepts the plain-array response shape too (VK API version differences)', async () => {
  const result = await withFetch(
    () => jsonResponse({ response: [{ id: 1, screen_name: 'club1', name: 'Club One' }] }),
    () => verifyVkGroupToken('good-token'),
  )
  assert.equal(result.ok, true)
  assert.ok(result.ok && result.identity.groupId === '1')
})

test('accepts the {count, items} response shape too', async () => {
  const result = await withFetch(
    () => jsonResponse({ response: { count: 1, items: [{ id: 2, screen_name: 'club2', name: 'Club Two' }] } }),
    () => verifyVkGroupToken('good-token'),
  )
  assert.equal(result.ok, true)
  assert.ok(result.ok && result.identity.groupId === '2')
})

test('a user access token (or any token with no resolvable community) is rejected, not guessed', async () => {
  const result = await withFetch(
    () => jsonResponse({ response: { groups: [] } }),
    () => verifyVkGroupToken('user-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && /community/i.test(result.error))
})

test('a VK API error (e.g. invalid/revoked token) is surfaced, not silently treated as connected', async () => {
  const result = await withFetch(
    () => jsonResponse({ error: { error_code: 5, error_msg: 'User authorization failed: invalid access_token.' } }),
    () => verifyVkGroupToken('revoked-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('invalid access_token'))
})

test('a network failure is surfaced as an error, not thrown past the caller', async () => {
  const result = await withFetch(
    () => new Error('getaddrinfo ENOTFOUND api.vk.com'),
    () => verifyVkGroupToken('any-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('ENOTFOUND'))
})
