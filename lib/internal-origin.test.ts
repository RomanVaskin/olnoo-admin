import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchPageMeta } from './html-extract.ts'
import { internalFetcher, normalizeInternalBase } from './internal-origin.ts'
import { fetchSitemapUrls } from './sitemap.ts'

const PUBLIC = 'https://site.example'
const PAGES = ['/', '/polirovka-avto', '/himchistka-avto', '/ru/o-nas']

/** A local "site on the same server": sitemap with PUBLIC <loc>s and one page per url; records every request. */
async function withLocalSite<T>(fn: (base: string, seen: { url: string; host: string }[]) => Promise<T>): Promise<T> {
  const seen: { url: string; host: string }[] = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', host: req.headers.host ?? '' })
    if (req.url === '/sitemap.xml') {
      res.end(`<urlset>${PAGES.map((p) => `<url><loc>${PUBLIC}${p}</loc></url>`).join('')}</urlset>`)
    } else if (PAGES.includes(req.url ?? '')) {
      res.end(`<html lang="ru"><head><title>T ${req.url}</title></head><body><h1>H</h1></body></html>`)
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('internal base: only http(s) on loopback is accepted, anything else is ignored', () => {
  assert.equal(normalizeInternalBase('http://127.0.0.1:3230')?.origin, 'http://127.0.0.1:3230')
  assert.equal(normalizeInternalBase('http://localhost:3230/')?.origin, 'http://localhost:3230')
  for (const bad of [null, '', '  ', 'driveset.ru', 'https://driveset.ru', 'http://10.0.0.5:3230', 'ftp://127.0.0.1']) {
    assert.equal(normalizeInternalBase(bad), null, String(bad))
  }
  assert.equal(internalFetcher(`${PUBLIC}/sitemap.xml`, null), undefined)
  assert.equal(internalFetcher(`${PUBLIC}/sitemap.xml`, 'https://evil.example'), undefined)
})

test('same-server project: sitemap and pages are read from the internal base, saved URLs stay public (repeatable)', async () => {
  await withLocalSite(async (base, seen) => {
    const routing = internalFetcher(`${PUBLIC}/sitemap.xml`, base)!
    for (let run = 1; run <= 5; run++) {
      seen.length = 0
      const urls = await fetchSitemapUrls(`${PUBLIC}/sitemap.xml`, { retryDelayMs: 0 }, routing)
      assert.deepEqual(urls, PAGES.map((p) => `${PUBLIC}${p}`), `run ${run}`)
      const metas = await Promise.all(urls.map((u) => fetchPageMeta(u, { retryDelayMs: 0 }, routing)))
      assert.ok(metas.every((m) => m?.title?.startsWith('T ')), `run ${run}: every page parsed`)
      assert.equal(metas[3]?.locale, 'RU')
      assert.equal(seen.length, 1 + PAGES.length)
      assert.deepEqual(seen.map((r) => r.url).sort(), ['/sitemap.xml', ...PAGES].sort(), 'same pathnames requested on the local server')
    }
  })
})

test('project without internal base keeps using the public URL; a foreign host is never rewritten', async () => {
  const original = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested.push(String(url))
    return new Response('<urlset><url><loc>https://other.example/x</loc></url></urlset>')
  }) as typeof fetch
  try {
    assert.deepEqual(await fetchSitemapUrls(`${PUBLIC}/sitemap.xml`, { retryDelayMs: 0 }), ['https://other.example/x'])
    assert.deepEqual(requested, [`${PUBLIC}/sitemap.xml`])
    const routing = internalFetcher(`${PUBLIC}/sitemap.xml`, 'http://127.0.0.1:3230')!
    assert.equal(routing.fetchUrl('https://other.example/x?y=1'), 'https://other.example/x?y=1')
    assert.equal(routing.fetchUrl(`${PUBLIC}/a/b?y=1`), 'http://127.0.0.1:3230/a/b?y=1')
  } finally {
    globalThis.fetch = original
  }
})
