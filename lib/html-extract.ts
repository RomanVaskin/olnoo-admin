import * as cheerio from 'cheerio'

const USER_AGENT = 'OLNOO-Admin-Sync/1.0'
const LOCALE_PREFIXES = new Set(['ru', 'en', 'kk', 'kz'])

export type PageMeta = {
  title: string | null
  h1: string | null
  description: string | null
  locale: string | null
}

/** Fetches a page and extracts the fields the Pages screen displays. Returns null on any failure. */
export async function fetchPageMeta(url: string): Promise<PageMeta | null> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
    if (!res.ok) return null

    const html = await res.text()
    const $ = cheerio.load(html)

    const title = $('title').first().text().trim() || null
    const h1 = $('h1').first().text().trim() || null
    const description =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim() ||
      null

    const htmlLang = $('html').attr('lang')?.trim().toLowerCase()
    const pathPrefix = new URL(url).pathname.match(/^\/([a-z]{2})(\/|$)/i)?.[1]?.toLowerCase()
    const localeGuess = htmlLang?.split('-')[0] || pathPrefix
    const locale = localeGuess && LOCALE_PREFIXES.has(localeGuess) ? localeGuess.toUpperCase() : null

    return { title, h1, description, locale }
  } catch {
    return null
  }
}
