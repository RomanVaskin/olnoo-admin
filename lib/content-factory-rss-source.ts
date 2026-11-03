import { load } from 'cheerio'
import type { RawSourceMessage } from './content-factory-telegram-source.ts'
import { fetchSourceDocument, publicSourceUrl } from './content-factory-web-fetch.ts'

export function sourcePlainText(html: string): string {
  const $ = load(html)
  $('script, style, nav, footer, form, aside, iframe').remove()
  $('br').replaceWith('\n')
  $('p, div, li, h1, h2, h3').append('\n')
  return $.root().text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim()
}
export function parseFeed(xml: string, baseUrl: string): RawSourceMessage[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Feed document declarations are not supported.')
  const $ = load(xml, { xmlMode: true })
  if (!$('rss, feed, rdf\\:RDF').length) throw new Error('Not a supported RSS/Atom feed.')
  const messages = new Map<string, RawSourceMessage>()
  $('item, entry').slice(0, 50).each((_, node) => {
    const item = $(node)
    const title = sourcePlainText(item.children('title').text())
    const link = item.children('link').filter((_, n) => !$(n).attr('rel') || $(n).attr('rel') === 'alternate').first()
    let url: string
    try { url = publicSourceUrl(new URL(link.attr('href') || link.text(), baseUrl).href).href } catch { return }
    if (!title || !(link.attr('href') || link.text()).trim()) return
    const content = item.children('content\\:encoded, content').first().text()
    const description = item.children('description, summary').first().text()
    const body = sourcePlainText(content || description)
    if (!body) return
    const date = item.children('pubDate, published, updated, dc\\:date').first().text()
    const publishedAt = date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : ''
    // URL is stable even when a publisher changes its GUID. Existing DB uniqueness is atomic.
    messages.set(url, { externalId: url, url, text: `${title}\n\n[RSS/Atom: ${content ? 'provided feed content; completeness not independently verified' : 'description/preview only, not a full article'}]\n\n${body}`, imageUrls: [], publishedAt })
  })
  if (!messages.size && $('item, entry').length) throw new Error('Feed entries have no usable title, link and text.')
  return [...messages.values()]
}
export async function fetchRssSource(url: string): Promise<RawSourceMessage[]> {
  const document = await fetchSourceDocument(url)
  return parseFeed(document.text, document.url)
}
