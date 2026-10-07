import { fetchTextWithRetry, type RetryOptions } from './fetch-retry.ts'

const USER_AGENT = 'OLNOO-Admin-Sync/1.0'
const MAX_SITEMAPS = 20

/**
 * The ONE place that decides which sitemap a project is read from (Pages sync and Technical SEO both call it):
 * `projects.sitemap_url` when it is set, otherwise `<domain>/sitemap.xml`. Returns null when neither gives a valid absolute URL.
 */
export function resolveSitemapUrl(project: { domain?: string | null; sitemap_url?: string | null }): string | null {
  try {
    const explicit = (project.sitemap_url ?? '').trim()
    const candidate = explicit || (project.domain ? new URL('/sitemap.xml', project.domain.trim().replace(/\/+$/, '') + '/').toString() : '')
    const u = new URL(candidate)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

export type SitemapRead = {
  /** The sitemap URL that was asked for (the root of the tree). */
  url: string
  /** root document: ok (a sitemap), missing (404), error (other HTTP status, not a sitemap, or unreachable). */
  status: 'ok' | 'missing' | 'error'
  httpStatus: number | null
  /** Every page URL listed (index files followed one level deep, bounded by MAX_SITEMAPS). */
  urls: string[]
}

const looksLikeSitemap = (xml: string) => /<urlset[\s>]/i.test(xml) || /<sitemapindex[\s>]/i.test(xml)

/**
 * Reads a sitemap tree. Never throws for the ROOT document: its state is returned (missing / error) so a caller can show it.
 * A permanent 4xx on a nested sitemap is skipped; a nested network failure is thrown only through `fetchSitemapUrls` (Pages sync).
 */
export async function readSitemap(sitemapUrl: string, retry: RetryOptions = {}, throwOnRootFailure = false): Promise<SitemapRead> {
  const seen = new Set<string>()
  const queue = [sitemapUrl]
  const urls = new Set<string>()
  let status: SitemapRead['status'] = 'ok'
  let httpStatus: number | null = null

  while (queue.length && seen.size < MAX_SITEMAPS) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    const isRoot = current === sitemapUrl

    let res
    try {
      res = await fetchTextWithRetry(current, { headers: { 'user-agent': USER_AGENT } }, retry)
    } catch (err) {
      if (isRoot && !throwOnRootFailure) {
        status = 'error'
        break
      }
      throw err
    }
    if (isRoot) httpStatus = res.status
    if (!res.ok) {
      if (isRoot) status = res.status === 404 ? 'missing' : 'error'
      continue
    }
    const xml = res.text
    if (isRoot && !looksLikeSitemap(xml)) {
      status = 'error'
      continue
    }

    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim())
    if (/<sitemapindex/i.test(xml)) {
      for (const loc of locs) queue.push(loc)
    } else {
      for (const loc of locs) urls.add(loc)
    }
  }

  return { url: sitemapUrl, status, httpStatus, urls: Array.from(urls) }
}

/**
 * Fetches a sitemap.xml and returns every page URL it lists (Pages sync).
 * Follows sitemap index files (nested <sitemap><loc>) one level deep,
 * bounded by MAX_SITEMAPS so a malformed/looping index can't hang the sync.
 * Each fetch has a timeout and up to 3 attempts on network errors / timeouts / 5xx; a permanent 4xx sitemap is
 * skipped as before, and when all attempts fail the error (naming the url and reason) is thrown, not hidden.
 */
export async function fetchSitemapUrls(sitemapUrl: string, retry: RetryOptions = {}): Promise<string[]> {
  return (await readSitemap(sitemapUrl, retry, true)).urls
}
