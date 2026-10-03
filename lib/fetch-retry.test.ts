import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchPageMeta } from './html-extract.ts'
import { fetchSitemapUrls } from './sitemap.ts'
import { fetchTextWithRetry, FetchRetryError } from './fetch-retry.ts'

const NO_DELAY = { retryDelayMs: 0 }

type Step = Response | Error | 'hang'
/** Replaces global fetch with a scripted sequence of answers; records the urls requested. */
async function withFetch<T>(steps: Step[], fn: (calls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url))
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]
    if (step instanceof Error) throw step
    if (step === 'hang') {
      // A real fetch keeps the event loop alive while waiting; the ref'd timer stands in for that.
      return new Promise((_, reject) => {
        const keepAlive = setTimeout(() => {}, 5_000)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive)
          reject(init.signal!.reason)
        })
      })
    }
    return step.clone()
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

const netErr = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
const xml = (...locs: string[]) => new Response(`<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`, { status: 200 })
const html = new Response('<html lang="ru"><head><title>T</title></head><body><h1>H</h1></body></html>', { status: 200 })

test('sitemap: a transient network error / 503 is retried and the sync goes on', async () => {
  await withFetch([netErr(), new Response('', { status: 503 }), xml('https://x.example/a')], async (calls) => {
    assert.deepEqual(await fetchSitemapUrls('https://x.example/sitemap.xml', NO_DELAY), ['https://x.example/a'])
    assert.equal(calls.length, 3)
  })
})

test('sitemap: after 3 failed attempts the error stays understandable (url, reason, attempts)', async () => {
  await withFetch([netErr()], async (calls) => {
    await assert.rejects(
      fetchSitemapUrls('https://x.example/sitemap.xml', NO_DELAY),
      (err: Error) => err instanceof FetchRetryError && /sitemap\.xml: ECONNRESET after 3 attempts/.test(err.message),
    )
    assert.equal(calls.length, 3)
  })
})

test('sitemap: a permanent 4xx is not retried (skipped as before)', async () => {
  await withFetch([new Response('', { status: 404 })], async (calls) => {
    assert.deepEqual(await fetchSitemapUrls('https://x.example/sitemap.xml', NO_DELAY), [])
    assert.equal(calls.length, 1)
  })
})

test('page: retried after a timeout, then parsed', async () => {
  await withFetch(['hang', html], async (calls) => {
    const meta = await fetchPageMeta('https://x.example/ru/p', { retryDelayMs: 0, timeoutMs: 20 })
    assert.equal(meta?.title, 'T')
    assert.equal(meta?.h1, 'H')
    assert.equal(calls.length, 2)
  })
})

test('page: 4xx is not retried and gives null; a persistent failure gives null after 3 attempts', async () => {
  await withFetch([new Response('', { status: 404 })], async (calls) => {
    assert.equal(await fetchPageMeta('https://x.example/gone', NO_DELAY), null)
    assert.equal(calls.length, 1)
  })
  await withFetch([netErr()], async (calls) => {
    assert.equal(await fetchPageMeta('https://x.example/down', NO_DELAY), null)
    assert.equal(calls.length, 3)
  })
})

test('timeout is reported as such when every attempt hangs', async () => {
  await withFetch(['hang'], async () => {
    await assert.rejects(fetchTextWithRetry('https://x.example/', {}, { retryDelayMs: 0, timeoutMs: 10 }), /timeout after 3 attempts/)
  })
})

test('a recovered fetch and an exhausted one are logged with the number of failed attempts', async () => {
  const original = { warn: console.warn, error: console.error }
  const logs: string[] = []
  console.warn = (m: string) => void logs.push(`warn ${m}`)
  console.error = (m: string) => void logs.push(`error ${m}`)
  try {
    await withFetch([netErr(), netErr(), xml('https://x.example/a')], async () => {
      await fetchTextWithRetry('https://x.example/sitemap.xml', {}, NO_DELAY)
    })
    await withFetch([netErr()], async () => {
      await assert.rejects(fetchTextWithRetry('https://x.example/down', {}, NO_DELAY))
    })
  } finally {
    console.warn = original.warn
    console.error = original.error
  }
  assert.deepEqual(logs, [
    'warn [pages-sync] https://x.example/sitemap.xml: ok on attempt 3 after 2 failed (last: ECONNRESET)',
    'error [pages-sync] https://x.example/down: all 3 attempts failed (last: ECONNRESET)',
  ])
})
