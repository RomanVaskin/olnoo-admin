// Technical SEO preflight (PR1): site, robots.txt, sitemap and a per-URL check of what the sitemap lists. Read-only,
// no storage, no crawler: one fetch per URL, capped. Severity rules live here (ERROR / WARNING / OK), the UI only shows them.
import * as cheerio from 'cheerio'
import { readSitemap, resolveSitemapUrl } from './sitemap.ts'

const USER_AGENT = 'OLNOO-Admin-HealthCheck/1.0'
const TIMEOUT_MS = 10_000
/** Upper bound of sitemap URLs fetched per project in one check (the rest is reported as `truncated`). */
export const MAX_PAGES_PER_PROJECT = 100
const PAGE_CONCURRENCY = 5

export type CheckStatus = 'OK' | 'Warning' | 'Missing' | 'Error'
export type Severity = 'ERROR' | 'WARNING'
export type Issue = { severity: Severity; code: string; url?: string; message: string }

export type PageCheck = {
  url: string
  /** null when the request failed. */
  httpStatus: number | null
  canonical: string | null
  /** 'noindex' when `<meta name="robots|googlebot|yandex">` or `X-Robots-Tag` says so. */
  indexing: 'index' | 'noindex'
  title: string | null
  h1: string | null
  redirectTo: string | null
  inSitemap: true
}

export type ProjectHealth = {
  projectId: number
  projectName: string
  domain: string
  sitemapUrl: string | null
  site: { status: CheckStatus; httpStatus: number | null }
  robots: { status: CheckStatus; httpStatus: number | null; disallowAll: boolean }
  sitemap: { status: CheckStatus; httpStatus: number | null; urlCount: number | null }
  pages: PageCheck[]
  /** More URLs in the sitemap than MAX_PAGES_PER_PROJECT: only the first ones were fetched. */
  pagesTruncated: boolean
  issues: Issue[]
  errors: number
  warnings: number
  overall: 'OK' | 'Warning' | 'Error'
  checkedAt: string
}

// ---- pure analysis -----------------------------------------------------------------------------------------------

/** `User-agent: *` group with `Disallow: /` and no `Allow: /` (equal length: the less restrictive rule wins). */
export function robotsDisallowsAll(text: string): boolean {
  let inStar = false
  let sawRule = false
  let disallowRoot = false
  let allowRoot = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'user-agent') {
      if (sawRule) inStar = false // a new group starts after rules
      sawRule = false
      if (value === '*') inStar = true
    } else if (key === 'disallow' || key === 'allow') {
      sawRule = true
      if (!inStar) continue
      if (key === 'disallow' && value === '/') disallowRoot = true
      if (key === 'allow' && value === '/') allowRoot = true
    }
  }
  return disallowRoot && !allowRoot
}

const normalizeUrl = (value: string, base: string): string | null => {
  try {
    const u = new URL(value, base)
    u.hash = ''
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname
    return `${u.origin}${path}${u.search}`
  } catch {
    return null
  }
}

/** Extracts what the check needs from a page answer. */
export function analyzePage(url: string, httpStatus: number, html: string, headers: { get(name: string): string | null }): Omit<PageCheck, 'inSitemap'> {
  const redirectTo = httpStatus >= 300 && httpStatus < 400 ? headers.get('location') : null
  const $ = cheerio.load(html)
  const robotsMeta = $('meta[name]')
    .filter((_, el) => /^(robots|googlebot|yandex)$/i.test($(el).attr('name') ?? ''))
    .map((_, el) => $(el).attr('content') ?? '')
    .get()
    .join(',')
  const noindex = /(^|[\s,])noindex([\s,]|$)/i.test(robotsMeta) || /(^|[\s,])noindex([\s,]|$)/i.test(headers.get('x-robots-tag') ?? '')
  const canonicalRaw = $('link[rel~="canonical"]').first().attr('href')?.trim() || null
  return {
    url,
    httpStatus,
    canonical: canonicalRaw ? (normalizeUrl(canonicalRaw, url) ?? canonicalRaw) : null,
    indexing: noindex ? 'noindex' : 'index',
    title: $('title').first().text().trim() || null,
    h1: $('h1').first().text().trim() || null,
    redirectTo,
  }
}

/** Severity rules for one sitemap URL. A failed/redirected page is not analysed further (no HTML to trust). */
export function pageIssues(p: PageCheck): Issue[] {
  const out: Issue[] = []
  const add = (severity: Severity, code: string, message: string) => out.push({ severity, code, url: p.url, message })
  if (p.httpStatus === null) return [{ severity: 'ERROR', code: 'page_unreachable', url: p.url, message: 'URL from the sitemap is unreachable' }]
  if (p.httpStatus >= 400) return [{ severity: 'ERROR', code: 'page_http_error', url: p.url, message: `URL from the sitemap returns HTTP ${p.httpStatus}` }]
  if (p.redirectTo !== null) return [{ severity: 'WARNING', code: 'page_redirect', url: p.url, message: `URL from the sitemap redirects (HTTP ${p.httpStatus}) to ${p.redirectTo}` }]
  if (p.indexing === 'noindex') add('ERROR', 'noindex_in_sitemap', 'Page is noindex but listed in the sitemap')
  if (!p.canonical) add('WARNING', 'canonical_missing', 'Canonical is missing')
  else if (normalizeUrl(p.url, p.url) !== normalizeUrl(p.canonical, p.url)) add('WARNING', 'canonical_mismatch', `Canonical points to ${p.canonical}, not to this URL`)
  if (!p.title) add('WARNING', 'title_missing', 'Title is missing')
  if (!p.h1) add('WARNING', 'h1_missing', 'H1 is missing')
  return out
}

export function summarize(issues: Issue[]): { errors: number; warnings: number; overall: ProjectHealth['overall'] } {
  const errors = issues.filter((i) => i.severity === 'ERROR').length
  const warnings = issues.length - errors
  return { errors, warnings, overall: errors ? 'Error' : warnings ? 'Warning' : 'OK' }
}

// ---- fetching ----------------------------------------------------------------------------------------------------

async function fetchOnce(url: string, redirect: RequestRedirect): Promise<Response> {
  return fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

async function checkSite(origin: string): Promise<ProjectHealth['site']> {
  try {
    const res = await fetchOnce(origin, 'follow')
    return { status: res.status >= 200 && res.status < 400 ? 'OK' : 'Error', httpStatus: res.status }
  } catch {
    return { status: 'Error', httpStatus: null }
  }
}

/** Missing robots.txt is a WARNING; `Disallow: /` for all agents is an ERROR; an unreadable answer is a WARNING. */
async function checkRobots(origin: string): Promise<ProjectHealth['robots']> {
  try {
    const res = await fetchOnce(new URL('/robots.txt', origin + '/').toString(), 'follow')
    if (res.status === 404 || res.status === 410) return { status: 'Missing', httpStatus: res.status, disallowAll: false }
    if (!res.ok) return { status: 'Warning', httpStatus: res.status, disallowAll: false }
    const disallowAll = robotsDisallowsAll(await res.text())
    return { status: disallowAll ? 'Error' : 'OK', httpStatus: res.status, disallowAll }
  } catch {
    return { status: 'Warning', httpStatus: null, disallowAll: false }
  }
}

async function checkPage(url: string): Promise<PageCheck> {
  try {
    const res = await fetchOnce(url, 'manual')
    const html = res.status >= 200 && res.status < 300 ? await res.text() : ''
    return { ...analyzePage(url, res.status, html, res.headers), inSitemap: true }
  } catch {
    return { url, httpStatus: null, canonical: null, indexing: 'index', title: null, h1: null, redirectTo: null, inSitemap: true }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

export async function checkProjectHealth(project: { id: number; name: string; domain: string; sitemap_url?: string | null }): Promise<ProjectHealth> {
  const origin = project.domain.trim().replace(/\/+$/, '')
  const sitemapUrl = resolveSitemapUrl(project)

  const [site, robots, sm] = await Promise.all([
    checkSite(origin),
    checkRobots(origin),
    sitemapUrl ? readSitemap(sitemapUrl, { attempts: 2, timeoutMs: TIMEOUT_MS, retryDelayMs: 500, logTag: 'seo-health' }) : Promise.resolve(null),
  ])

  const sitemap: ProjectHealth['sitemap'] = sm
    ? { status: sm.status === 'ok' ? 'OK' : sm.status === 'missing' ? 'Missing' : 'Error', httpStatus: sm.httpStatus, urlCount: sm.status === 'ok' ? sm.urls.length : null }
    : { status: 'Error', httpStatus: null, urlCount: null }

  const toCheck = sm?.status === 'ok' ? sm.urls.slice(0, MAX_PAGES_PER_PROJECT) : []
  const pages = await mapLimit(toCheck, PAGE_CONCURRENCY, checkPage)

  const issues: Issue[] = []
  if (site.status !== 'OK') issues.push({ severity: 'ERROR', code: 'site_unavailable', message: `Site is unavailable${site.httpStatus ? ` (HTTP ${site.httpStatus})` : ''}` })
  if (robots.disallowAll) issues.push({ severity: 'ERROR', code: 'robots_disallow_all', message: 'robots.txt closes the whole site (Disallow: /)' })
  else if (robots.status === 'Missing') issues.push({ severity: 'WARNING', code: 'robots_missing', message: 'robots.txt is missing' })
  else if (robots.status === 'Warning') issues.push({ severity: 'WARNING', code: 'robots_unreadable', message: `robots.txt could not be read${robots.httpStatus ? ` (HTTP ${robots.httpStatus})` : ''}` })
  if (sitemap.status !== 'OK') issues.push({ severity: 'ERROR', code: sitemap.status === 'Missing' ? 'sitemap_missing' : 'sitemap_unreadable', message: sitemap.status === 'Missing' ? 'Sitemap is missing' : 'Sitemap is unreadable' })
  for (const p of pages) issues.push(...pageIssues(p))

  return {
    projectId: project.id,
    projectName: project.name,
    domain: origin,
    sitemapUrl,
    site,
    robots,
    sitemap,
    pages,
    pagesTruncated: (sm?.urls.length ?? 0) > MAX_PAGES_PER_PROJECT,
    issues,
    ...summarize(issues),
    checkedAt: new Date().toISOString(),
  }
}
