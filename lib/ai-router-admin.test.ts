import test from 'node:test'
import assert from 'node:assert/strict'
import { GET, POST } from '../app/api/ai-router/route.ts'

const adminToken = 'a'.repeat(40)
const routerToken = 'b'.repeat(40)
const endpoint = 'http://localhost/api/ai-router'

async function withSecrets(fn: () => Promise<void>) {
  const oldAdmin = process.env.AI_ROUTER_SUPER_ADMIN_TOKEN
  const oldRouter = process.env.OLNOO_ROUTER_TOKEN
  process.env.AI_ROUTER_SUPER_ADMIN_TOKEN = adminToken
  process.env.OLNOO_ROUTER_TOKEN = routerToken
  try { await fn() } finally {
    if (oldAdmin === undefined) delete process.env.AI_ROUTER_SUPER_ADMIN_TOKEN
    else process.env.AI_ROUTER_SUPER_ADMIN_TOKEN = oldAdmin
    if (oldRouter === undefined) delete process.env.OLNOO_ROUTER_TOKEN
    else process.env.OLNOO_ROUTER_TOKEN = oldRouter
  }
}

test('server API refuses unauthenticated reads and checks before contacting Router', async () => {
  await withSecrets(async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('Router must not be called') }) as typeof fetch
    try {
      assert.equal((await GET(new Request(endpoint))).status, 403)
      assert.equal((await POST(new Request(endpoint, { method: 'POST', body: JSON.stringify({ provider: 'openai' }) }))).status, 403)
      assert.equal((await GET(new Request(endpoint, { headers: { Authorization: 'Bearer wrong' } }))).status, 403)
    } finally { globalThis.fetch = original }
  })
})

test('missing Super Admin secret fails closed', async () => {
  const old = process.env.AI_ROUTER_SUPER_ADMIN_TOKEN
  delete process.env.AI_ROUTER_SUPER_ADMIN_TOKEN
  try { assert.equal((await GET(new Request(endpoint, { headers: { Authorization: `Bearer ${adminToken}` } }))).status, 403) }
  finally { if (old !== undefined) process.env.AI_ROUTER_SUPER_ADMIN_TOKEN = old }
})

test('authorized catalog returns only whitelisted data and keeps unknown values null', async () => {
  await withSecrets(async () => {
    const original = globalThis.fetch
    let called = ''
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      called = String(url)
      assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${routerToken}`)
      return new Response(JSON.stringify({
        providers: [{ name: 'openai', connected: true, available: null, lastError: null, checkedAt: null, models: [{ id: 'gpt-test', label: 'GPT Test', secret: 'hidden' }], secret: 'hidden' }],
        presets: [{ key: 'driveset.image', service: 'driveset', task: 'image', provider: 'openai', model: 'gpt-image-1-mini', quality: 'medium', secret: 'hidden' }],
        secret: 'hidden',
      }))
    }) as typeof fetch
    try {
      const res = await GET(new Request(endpoint, { headers: { Authorization: `Bearer ${adminToken}` } }))
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.match(called, /\/v1\/admin\/catalog$/)
      const body = await res.text()
      assert.doesNotMatch(body, /hidden|"secret"/)
      assert.deepEqual(JSON.parse(body).providers[0].available, null)
    } finally { globalThis.fetch = original }
  })
})

test('authorized provider check validates name and hides upstream errors', async () => {
  await withSecrets(async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('upstream secret', { status: 502 }) }) as typeof fetch
    try {
      const headers = { Authorization: `Bearer ${adminToken}` }
      assert.equal((await POST(new Request(endpoint, { method: 'POST', headers, body: JSON.stringify({ provider: 'invalid' }) }))).status, 400)
      assert.equal(calls, 0)
      const res = await POST(new Request(endpoint, { method: 'POST', headers, body: JSON.stringify({ provider: 'openai' }) }))
      assert.equal(res.status, 502)
      assert.doesNotMatch(await res.text(), /upstream secret/)
      assert.equal(calls, 1)
    } finally { globalThis.fetch = original }
  })
})

test('authorized provider check returns only the Router check status', async () => {
  await withSecrets(async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      assert.match(String(url), /\/v1\/admin\/providers\/gemini\/check$/)
      return new Response(JSON.stringify({ name: 'gemini', connected: true, available: true, lastError: null, checkedAt: '2026-11-02T12:00:00.000Z', secret: 'hidden' }))
    }) as typeof fetch
    try {
      const res = await POST(new Request(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ provider: 'gemini' }) }))
      assert.equal(res.status, 200)
      const body = await res.text()
      assert.doesNotMatch(body, /hidden/)
      assert.deepEqual(JSON.parse(body), { name: 'gemini', connected: true, available: true, lastError: null, checkedAt: '2026-11-02T12:00:00.000Z' })
    } finally { globalThis.fetch = original }
  })
})
