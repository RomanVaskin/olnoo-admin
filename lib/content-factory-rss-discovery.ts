import type { Pool } from 'pg'
import { createSource, listSources } from './content-factory-sources.ts'
import { load } from 'cheerio'
import { fetchSourceDocument, publicSourceUrl } from './content-factory-web-fetch.ts'
import { parseFeed } from './content-factory-rss-source.ts'

type Reader = typeof fetchSourceDocument
export type RssDiscoveryInput = { country: string; topics: string; language: string }
export type DiscoveredRss = { name: string; url: string; topics: string; language: string; status: 'verified' }
export class RssDiscoveryError extends Error {}
export function rssUrlKey(value: string): string {
  const url = publicSourceUrl(value)
  url.searchParams.sort()
  return url.href
}
export async function verifyDiscoveredFeed(url: string, topics: string, read: Reader = fetchSourceDocument): Promise<DiscoveredRss> {
  const doc = await read(rssUrlKey(url))
  if (!parseFeed(doc.text, doc.url).length) throw new RssDiscoveryError('Лента не содержит доступных публикаций.')
  const $ = load(doc.text, { xmlMode: true })
  return { name: $('channel > title, feed > title').first().text().trim() || new URL(doc.url).hostname,
    url: rssUrlKey(doc.url), topics, language: $('channel > language').first().text().trim() || $('feed').attr('xml:lang') || 'Не указан', status: 'verified' }
}
export async function discoverRss(input: RssDiscoveryInput, connected: string[], read: Reader = fetchSourceDocument): Promise<DiscoveredRss[]> {
  for (const value of [input.country, input.topics, input.language]) if (!value?.trim() || value.length > 160) throw new RssDiscoveryError('Укажите страну, темы и язык (до 160 символов в поле).')
  const query = new URL('https://www.bing.com/search')
  query.searchParams.set('format', 'rss')
  query.searchParams.set('q', `${input.country} ${input.topics} ${input.language} news RSS`)
  let sites: string[]
  try {
    const doc = await read(query.href)
    const $ = load(doc.text, { xmlMode: true })
    if (!$('rss > channel').length) throw new Error('Unexpected search response')
    sites = [...new Set($('channel > item > link').map((_, el) => {
      try { return rssUrlKey($(el).text().trim()) } catch { return '' }
    }).get().filter(Boolean))].slice(0, 4)
  } catch { throw new RssDiscoveryError('Веб-поиск Bing недоступен или вернул некорректный ответ. Попробуйте позже; результаты не созданы.') }
  const seen = new Set(connected.map((url) => { try { return rssUrlKey(url) } catch { return url } }))
  const results: DiscoveredRss[] = []
  for (const site of sites) {
    try {
      const page = await read(site)
      const $ = load(page.text)
      const alternate = $('link[rel~="alternate"]').filter((_, el) => /(?:rss|atom)\+xml/i.test($(el).attr('type') || '')).map((_, el) => new URL($(el).attr('href') || '', page.url).href).get()
      const candidates = [...new Set([page.url, ...alternate.slice(0, 3), ...['/feed', '/rss', '/rss.xml', '/atom.xml'].map((path) => new URL(path, page.url).href)])]
      const verified = await Promise.allSettled(candidates.filter((url) => !seen.has(rssUrlKey(url))).map((url) => verifyDiscoveredFeed(url, input.topics, read)))
      for (const candidate of verified) {
        if (candidate.status !== 'fulfilled' || seen.has(candidate.value.url)) continue
        seen.add(candidate.value.url)
        results.push(candidate.value)
        if (results.length >= 8) return results
      }
    } catch { /* A search hit is not proof of an accessible site/feed. */ }
  }
  return results
}

export async function connectRssSource(pool: Pool, projectId: number, feed: DiscoveredRss) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(78216, $1)', [projectId])
    const db = client as unknown as Pool
    const sources = await listSources(db, projectId)
    if (sources.some((s) => { try { return s.type === 'rss' && rssUrlKey(s.handle) === feed.url } catch { return false } })) {
      throw new RssDiscoveryError('Эта RSS-лента уже подключена.')
    }
    const source = await createSource(db, projectId, { type: 'rss', handle: feed.url })
    await client.query('COMMIT')
    return source
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
