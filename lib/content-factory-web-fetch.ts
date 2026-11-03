import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export function publicSourceUrl(value: string): URL {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Use a public HTTP(S) source URL without credentials.')
  url.hash = ''
  return url
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 6) return !/^(::|fc|fd|fe[89ab]|ff)/i.test(address)
  const [a, b] = address.split('.').map(Number)
  return isIP(address) === 4 && !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))
}
/** Bounded public requests; redirects are validated again, without cookies or credentials. */
export async function fetchSourceDocument(value: string): Promise<{ text: string; url: string }> {
  let url = publicSourceUrl(value)
  for (let redirects = 0; redirects <= 3; redirects++) {
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Private/internal source addresses are not allowed.')
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'OLNOOContentFactory/1.0', Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, text/html' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('Source redirect has no location.')
      url = publicSourceUrl(new URL(location, url).href)
      continue
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Source unavailable (HTTP ${response.status}).`) }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Source returned an empty response.')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 2_000_000) throw new Error('Source response exceeds 2 MB.')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    return { text: Buffer.concat(chunks).toString('utf8'), url: url.href }
  }
  throw new Error('Too many source redirects.')
}
