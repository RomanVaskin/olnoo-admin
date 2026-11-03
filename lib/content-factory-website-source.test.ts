import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverFeed, sectionArticles, parseWebsiteArticle, fetchWebsiteSource } from './content-factory-website-source.ts'
const now = Date.parse('2026-11-03T00:00:00Z')
const section = '<nav><a href="/ad">Ad</a></nav><article><h2><a href="/one">Title</a></h2><time datetime="2026-11-01"/></article>'
const body = '<main><article><h1>Housing news</h1><aside>ADVERTISEMENT</aside><p>' + 'Verified factual details about the housing market. '.repeat(5) + '</p><p>Price 123 USD. No additional claims.</p></article></main>'
test('website advertises RSS as a separate source', async () => {
  const html = '<link rel="alternate" type="application/rss+xml" href="/feed.xml">'
  assert.equal(discoverFeed(html, 'https://example.com/news'), 'https://example.com/feed.xml')
  await assert.rejects(() => fetchWebsiteSource('https://example.com/news', async (url) => ({ url, text: url.endsWith('/robots.txt') ? '' : html })), /add this URL as an RSS source/)
})
test('section restricts to same-site dated recent articles and removes duplicates', () => {
  assert.deepEqual(sectionArticles(section + section, 'https://example.com/news', now), [{ url: 'https://example.com/one', date: '2026-11-01T00:00:00.000Z' }])
  assert.throws(() => sectionArticles(section.replace('2026-11-01', '2020-01-01'), 'https://example.com/news', now), /recent/)
  assert.throws(() => sectionArticles('<nav><a href="/one">Title</a></nav>', 'https://example.com/news', now), /reliably/)
})
test('article extraction excludes ads, keeps facts and does not import photos', () => {
  const item = parseWebsiteArticle(body, 'https://example.com/one', '2026-11-01')
  assert.match(item.text, /Housing news/)
  assert.match(item.text, /123 USD/)
  assert.doesNotMatch(item.text, /ADVERTISEMENT/)
  assert.deepEqual(item.imageUrls, [])
  assert.throws(() => parseWebsiteArticle('<article><h1>Title</h1><p>Teaser</p></article>', item.url, ''), /reliably|short/)
})
test('robots and unavailable sources fail without creating content', async () => {
  await assert.rejects(() => fetchWebsiteSource('https://example.com/news', async (url) => ({ url, text: 'User-agent: *\nDisallow: /news' })), /disallows/)
  await assert.rejects(() => fetchWebsiteSource('https://example.com/news', async () => { throw new Error('HTTP 403') }), /verify robots/)
})
test('website without RSS fetches article text through the existing adapter shape', async () => {
  const current = new Date().toISOString()
  const result = await fetchWebsiteSource('https://example.com/news', async (url) => ({ url, text: url.endsWith('robots.txt') ? '' : url.endsWith('/news') ? section.replace('2026-11-01', current) : body }))
  assert.equal(result.length, 1)
  assert.equal(result[0].externalId, 'https://example.com/one')
})
