import { load } from 'cheerio'
import type { RawSourceMessage } from './content-factory-telegram-source.ts'
import { sourcePlainText } from './content-factory-rss-source.ts'
import { fetchSourceDocument, publicSourceUrl } from './content-factory-web-fetch.ts'

type DocumentReader = typeof fetchSourceDocument
export function discoverFeed(html: string, base: string): string | null {
  const $ = load(html)
  const href = $('link[rel="alternate"]').filter((_, node) => /(?:rss|atom)\+xml/i.test($(node).attr('type') || '')).first().attr('href')
  return href ? publicSourceUrl(new URL(href, base).href).href : null
}
export function recentDate(value: string, now = Date.now()): string | null {
  const date = Date.parse(value)
  return Number.isFinite(date) && date <= now + 86400000 && date >= now - 30 * 86400000 ? new Date(date).toISOString() : null
}
/** MVP deliberately requires semantic news cards and dated articles, not arbitrary links. */
export function sectionArticles(html: string, base: string, now = Date.now()): { url: string; date: string }[] {
  const $ = load(html)
  $('nav, header, footer, aside, form, [role="navigation"]').remove()
  const found = new Map<string, { url: string; date: string }>()
  $('article').each((_, node) => {
    const card = $(node)
    const href = card.find('h2 a[href], h3 a[href], a[rel="bookmark"]').first().attr('href')
    const date = recentDate(card.find('time[datetime]').first().attr('datetime') || '', now)
    if (!href || !date) return
    try {
      const url = publicSourceUrl(new URL(href, base).href)
      if (url.origin === new URL(base).origin && url.href !== base) found.set(url.href, { url: url.href, date })
    } catch { /* Non-article links are ignored. */ }
  })
  if (!found.size) throw new Error('Cannot reliably extract recent dated articles. Supply a news section with article headings and time[datetime], or use RSS/Atom.')
  return [...found.values()].slice(0, 10)
}
export function parseWebsiteArticle(html: string, url: string, date: string): RawSourceMessage {
  const $ = load(html)
  if ($('input[type="password"], .g-recaptcha, [data-sitekey]').length) throw new Error('Article requires authentication or CAPTCHA; access will not be bypassed.')
  const title = $('article h1, main h1').first().text().trim()
  const body = $('[itemprop="articleBody"]').first().length ? $('[itemprop="articleBody"]').first() : $('article').first()
  body.find('nav, aside, footer, header, form, script, style, iframe, .advertisement, .ads, [role="navigation"], h1, time').remove()
  if (body.find('p').length < 2 || !title) throw new Error('Cannot reliably extract the article heading and main text.')
  const text = sourcePlainText(body.html() || '')
  if (text.length < 200) throw new Error('Article body is too short or unavailable; no complete article was imported.')
  return { externalId: url, url, text: `${title}\n\n${text}`, publishedAt: date, imageUrls: [] }
}
async function permitted(url: string, read: DocumentReader): Promise<void> {
  let robots: { text: string; url: string }
  try { robots = await read(new URL('/robots.txt', url).href) }
  catch (error) {
    if (error instanceof Error && error.message.includes('HTTP 404')) return
    throw new Error('Cannot verify robots.txt access rules. Source was not fetched.')
  }
  // Conservative MVP: honor every nonempty Disallow, including provider-specific restrictions.
  const path = new URL(url).pathname + new URL(url).search
  for (const line of robots.text.split('\n')) {
    const rule = /^\s*Disallow\s*:\s*([^#\s]+)/i.exec(line)?.[1]
    if (!rule) continue
    const pattern = rule.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$')
    if (new RegExp(`^${pattern}`).test(path)) throw new Error('Website disallows access in robots.txt. Use an authorized feed instead.')
  }
}
export async function fetchWebsiteSource(url: string, read: DocumentReader = fetchSourceDocument): Promise<RawSourceMessage[]> {
  publicSourceUrl(url)
  await permitted(url, read)
  const section = await read(url)
  if (section.url !== url) await permitted(section.url, read)
  const feed = discoverFeed(section.text, section.url)
  if (feed) throw new Error(`RSS/Atom is available: ${feed} — add this URL as an RSS source.`)
  const candidates = sectionArticles(section.text, section.url)
  const messages: RawSourceMessage[] = []
  for (const candidate of candidates) {
    await permitted(candidate.url, read)
    const article = await read(candidate.url)
    if (article.url !== candidate.url) await permitted(article.url, read)
    messages.push(parseWebsiteArticle(article.text, article.url, candidate.date))
  }
  return messages
}
