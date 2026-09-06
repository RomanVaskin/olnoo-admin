const USER_AGENT = 'OLNOO-Admin-Sync/1.0'
const MAX_SITEMAPS = 20

/**
 * Fetches a sitemap.xml and returns every page URL it lists.
 * Follows sitemap index files (nested <sitemap><loc>) one level deep,
 * bounded by MAX_SITEMAPS so a malformed/looping index can't hang the sync.
 */
export async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  const seen = new Set<string>()
  const queue = [sitemapUrl]
  const urls = new Set<string>()

  while (queue.length && seen.size < MAX_SITEMAPS) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)

    const res = await fetch(current, { headers: { 'user-agent': USER_AGENT } })
    if (!res.ok) continue
    const xml = await res.text()

    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim())
    if (/<sitemapindex/i.test(xml)) {
      for (const loc of locs) queue.push(loc)
    } else {
      for (const loc of locs) urls.add(loc)
    }
  }

  return Array.from(urls)
}
