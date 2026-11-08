import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverRss, verifyDiscoveredFeed } from './content-factory-rss-discovery.ts'
const input = { country: 'Cyprus', topics: 'Property', language: 'English' }
const feed = '<rss><channel><title>Publisher</title><language>en</language><item><title>News</title><link>https://publisher.example/article</link><description>Facts 123</description></item></channel></rss>'
const search = '<rss><channel><item><link>https://publisher.example/news</link></item><item><link>https://publisher.example/news</link></item></channel></rss>'

test('search checks discovered and common feed URLs, validates publications and deduplicates', async () => {
  const requests: string[] = []
  const read = async (url: string) => {
    requests.push(url)
    if (url.startsWith('https://www.bing.com/search')) {
      const query = new URL(url).searchParams.get('q')!
      for (const value of Object.values(input)) assert.ok(query.includes(value))
      return { url, text: search }
    }
    if (url.endsWith('/news')) return { url, text: '<link rel="alternate" type="application/rss+xml" href="/feed"><link rel="alternate" type="application/atom+xml" href="/atom.xml">' }
    if (url.endsWith('/feed') || url.endsWith('/rss')) return { url: 'https://publisher.example/feed', text: feed }
    throw new Error('HTTP 404')
  }
  const result = await discoverRss(input, [], read)
  assert.deepEqual(result, [{ name: 'Publisher', url: 'https://publisher.example/feed', language: 'en', topics: 'Property', status: 'verified' }])
  assert.ok(requests.includes('https://publisher.example/rss.xml'))
  assert.deepEqual(await discoverRss(input, ['https://publisher.example/feed'], read), [])
})
test('search failure and challenge page are explicit errors without invented results', async () => {
  await assert.rejects(() => discoverRss(input, [], async () => { throw new Error('HTTP 503') }), /Bing недоступен/)
  await assert.rejects(() => discoverRss(input, [], async (url) => ({ url, text: '<html>CAPTCHA</html>' })), /Bing недоступен/)
})
test('empty feeds and inaccessible candidates never appear in results', async () => {
  await assert.rejects(() => verifyDiscoveredFeed('https://publisher.example/feed', '', async (url) => ({ url, text: '<rss><channel/></rss>' })), /не содержит/)
  assert.deepEqual(await discoverRss(input, [], async (url) => {
    if (url.includes('bing.com/search')) return { url, text: search }
    return { url, text: '<html>Not a feed</html>' }
  }), [])
})
test('Atom language comes from feed metadata, not requested language', async () => {
  const result = await verifyDiscoveredFeed('https://publisher.example/atom.xml', 'Property', async (url) => ({ url, text: '<feed xml:lang="el"><title>Publisher</title><entry><title>News</title><link href="/story"/><content>Facts</content></entry></feed>' }))
  assert.equal(result.language, 'el')
  const unknown = await verifyDiscoveredFeed('https://publisher.example/feed', '', async (url) => ({ url, text: feed.replace('<language>en</language>', '') }))
  assert.equal(unknown.language, 'Не указан')
})

test('connect uses existing project registry in AI mode and rejects a repeated connection', async () => {
  const { connectRssSource } = await import('./content-factory-rss-discovery.ts')
  const rows: Record<string, unknown>[] = []
  const calls: string[] = []
  const client = { query: async (sql: string, values: unknown[] = []) => {
    calls.push(sql)
    if (sql.includes('pg_advisory_xact_lock')) assert.deepEqual(values, [7])
    if (sql.includes('FROM content_factory_sources s WHERE')) { assert.deepEqual(values, [7]); return { rows } }
    if (sql.startsWith('INSERT INTO content_factory_sources')) {
      assert.equal(values[1], 7)
      assert.equal(values[4], 'ai')
      rows.push({ id: values[0], project_id: 7, type: 'rss', handle: values[3], processing_mode: 'ai' })
      return { rows }
    }
    return { rows: [] }
  }, release: () => {} }
  const pool = { connect: async () => client } as unknown as import('pg').Pool
  const verified = { name: 'Site', url: 'https://example.com/feed', topics: 'Property', language: 'en', status: 'verified' as const }
  await connectRssSource(pool, 7, verified)
  await assert.rejects(() => connectRssSource(pool, 7, verified), /уже подключена/)
  assert.equal(calls.filter((sql) => sql.startsWith('INSERT')).length, 1)
  assert.ok(calls.includes('COMMIT'))
  assert.ok(calls.includes('ROLLBACK'))
})
