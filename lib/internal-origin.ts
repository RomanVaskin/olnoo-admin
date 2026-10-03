// Pages sync for a site that runs on the same server as Admin: fetch it through its internal (loopback)
// base URL instead of the public domain. Only the address used for the request changes; the URLs that are
// saved (sitemap <loc>, pages.url) stay public.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** A valid internal base: http(s) on a loopback host (no path). Anything else is ignored — returns null. */
export function normalizeInternalBase(raw: string | null | undefined): URL | null {
  if (!raw?.trim()) return null
  try {
    const u = new URL(raw.trim())
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK_HOSTS.has(u.hostname)) return null
    return u
  } catch {
    return null
  }
}

/**
 * Builds the `fetchUrl` hook of the sitemap / page fetchers: a URL on the project's public origin is requested
 * on the internal base (same path and query); any other URL is left untouched. Without a
 * valid internal base the returned hook is undefined, so the behaviour is exactly the old one.
 */
export function internalFetcher(
  publicUrl: string,
  internalBaseUrl: string | null | undefined,
): { fetchUrl: (url: string) => string } | undefined {
  const base = normalizeInternalBase(internalBaseUrl)
  if (!base) return undefined
  let publicOrigin: string
  try {
    publicOrigin = new URL(publicUrl).origin
  } catch {
    return undefined
  }
  const isPublic = (url: string) => {
    try {
      return new URL(url).origin === publicOrigin
    } catch {
      return false
    }
  }
  return {
    fetchUrl: (url) => {
      if (!isPublic(url)) return url
      const u = new URL(url)
      return `${base.origin}${u.pathname}${u.search}`
    },
  }
}
