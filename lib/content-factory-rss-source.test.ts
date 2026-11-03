import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFeed } from './content-factory-rss-source.ts'
import { publicAddress, publicSourceUrl } from './content-factory-web-fetch.ts'

test('RSS keeps title, preview, date, URL, excludes images and deduplicates URLs', () => {
  const entry = '<item><title>News</title><link>https://news.example/one</link><pubDate>2026-11-01</pubDate><description>&lt;p&gt;Price 123&lt;/p&gt;</description></item>'
  const items = parseFeed(`<rss><channel>${entry}${entry}</channel></rss>`, 'https://news.example/feed')
  assert.equal(items.length, 1)
  assert.match(items[0].text, /News.*\n/)
  assert.match(items[0].text, /preview only/)
  assert.match(items[0].text, /Price 123/)
  assert.equal(items[0].publishedAt, '2026-11-01T00:00:00.000Z')
  assert.deepEqual(items[0].imageUrls, [])
})
test('Atom supports namespaced feed, relative alternate links and content', () => {
  const [item] = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Title</title><id>stable</id><link href="/one"/><content type="html">&lt;p&gt;Body&lt;/p&gt;</content></entry></feed>', 'https://news.example/feed')
  assert.equal(item.url, 'https://news.example/one')
  assert.match(item.text, /completeness not independently verified/)
})
test('invalid feeds and empty entries fail clearly; empty valid feed is allowed', () => {
  assert.throws(() => parseFeed('<html>login</html>', 'https://example.com'), /supported/)
  assert.throws(() => parseFeed('<rss><item><title>Empty</title></item></rss>', 'https://example.com'), /usable/)
  assert.deepEqual(parseFeed('<rss><channel/></rss>', 'https://example.com'), [])
  assert.throws(() => publicSourceUrl('file:///etc/passwd'))
  for (const address of ['127.0.0.1', '10.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(address), false)
})
