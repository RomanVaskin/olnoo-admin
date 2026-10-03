import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AiRouterError, callAiRouter, SEO_BULK_ROUTE } from './ai-router.ts'

/** Replaces fetch for one call and returns the request body the Router would have received. */
async function withFetch<T>(answer: Record<string, unknown>, fn: () => Promise<T>): Promise<{ result: T; body: Record<string, unknown>; url: string }> {
  const original = globalThis.fetch
  let captured: { body: Record<string, unknown>; url: string } | null = null
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { body: JSON.parse(String(init?.body)), url: String(url) }
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const result = await fn()
    return { result, ...captured! }
  } finally {
    globalThis.fetch = original
  }
}

const messages = [{ role: 'user' as const, content: 'x' }]

test('callers without options keep the old request: provider openai with the usual fallback chain, no reasoningMode', async () => {
  const { body } = await withFetch({ content: 'ok', provider: 'openai' }, () => callAiRouter(messages))
  assert.equal(body.provider, 'openai')
  assert.equal(body.allowFallback, true)
  assert.equal('reasoningMode' in body, false)
  assert.equal(body.maxTokens, 12000)
})

test('SEO bulk route pins the request to deepseek, no fallback, reasoning off', async () => {
  assert.deepEqual(SEO_BULK_ROUTE, { provider: 'deepseek', allowFallback: false, reasoningMode: 'off' })
  const { body } = await withFetch({ content: 'ok', provider: 'deepseek' }, () => callAiRouter(messages, { ...SEO_BULK_ROUTE, task: 'seo-test' }))
  assert.equal(body.provider, 'deepseek')
  assert.equal(body.allowFallback, false)
  assert.equal(body.reasoningMode, 'off')
  assert.equal(body.model, null, 'the Router picks its DeepSeek default (deepseek-v4-flash)')
  assert.deepEqual(body.metadata, { application: 'olnoo-admin', task: 'seo-test' })
})

test('a pinned request answered by another provider is rejected, never used', async () => {
  await assert.rejects(
    withFetch({ content: 'from sonnet', provider: 'anthropic', fallbackUsed: true }, () => callAiRouter(messages, SEO_BULK_ROUTE)),
    (err: unknown) => err instanceof AiRouterError && /expected "deepseek"/.test(err.message),
  )
})
