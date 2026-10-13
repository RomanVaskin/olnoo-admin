import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyInstagramAccountToken } from './social-instagram-verify.ts'

/** Scripted global fetch (same approach as social-vk-verify.test.ts). */
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

test('a valid Business account token resolves the account id, username and account type', async () => {
  const result = await withFetch(
    () => jsonResponse({ user_id: '17841400000000000', username: 'olnoo_ai', account_type: 'BUSINESS' }),
    () => verifyInstagramAccountToken('good-token'),
  )
  assert.deepEqual(result, {
    ok: true,
    identity: { accountId: '17841400000000000', username: 'olnoo_ai', accountType: 'BUSINESS' },
  })
})

test('a Creator account token is accepted the same as Business', async () => {
  const result = await withFetch(
    () => jsonResponse({ user_id: '1', username: 'creator', account_type: 'MEDIA_CREATOR' }),
    () => verifyInstagramAccountToken('good-token'),
  )
  assert.equal(result.ok, true)
})

test('a personal (non-professional) account token is rejected, not silently accepted', async () => {
  const result = await withFetch(
    () => jsonResponse({ user_id: '1', username: 'someone', account_type: 'PERSONAL' }),
    () => verifyInstagramAccountToken('personal-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && /personal account/i.test(result.error))
})

test('a response with no user_id is rejected, not guessed', async () => {
  const result = await withFetch(
    () => jsonResponse({ username: 'someone' }),
    () => verifyInstagramAccountToken('bad-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && /account id/i.test(result.error))
})

test('an Instagram API error (e.g. invalid/revoked token) is surfaced, not silently treated as connected', async () => {
  const result = await withFetch(
    () => jsonResponse({ error: { message: 'Invalid OAuth access token.' } }, 400),
    () => verifyInstagramAccountToken('revoked-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('Invalid OAuth access token'))
})

test('a network failure is surfaced as an error, not thrown past the caller', async () => {
  const result = await withFetch(
    () => new Error('getaddrinfo ENOTFOUND graph.instagram.com'),
    () => verifyInstagramAccountToken('any-token'),
  )
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('ENOTFOUND'))
})
