const USER_AGENT = 'OLNOO-Admin-HealthCheck/1.0'
const TIMEOUT_MS = 10_000

export type CheckStatus = 'OK' | 'Missing' | 'Error'

export type ProjectHealth = {
  projectId: number
  projectName: string
  domain: string
  site: { status: CheckStatus; httpStatus: number | null }
  sitemap: { status: CheckStatus; httpStatus: number | null; urlCount: number | null }
  checkedAt: string
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Mirrors the <loc> extraction in lib/sitemap.ts, kept separate since a health check only reads the top-level document. */
function countLocs(xml: string): number {
  return [...xml.matchAll(/<loc>\s*[^<\s]+\s*<\/loc>/gi)].length
}

function looksLikeSitemap(xml: string): boolean {
  return /<urlset[\s>]/i.test(xml) || /<sitemapindex[\s>]/i.test(xml)
}

async function checkSite(origin: string): Promise<ProjectHealth['site']> {
  try {
    const res = await fetchWithTimeout(origin)
    return { status: res.status >= 200 && res.status < 400 ? 'OK' : 'Error', httpStatus: res.status }
  } catch {
    return { status: 'Error', httpStatus: null }
  }
}

async function checkSitemap(origin: string): Promise<ProjectHealth['sitemap']> {
  const url = new URL('/sitemap.xml', origin).toString()
  try {
    const res = await fetchWithTimeout(url)
    if (res.status === 404) return { status: 'Missing', httpStatus: res.status, urlCount: null }
    if (!res.ok) return { status: 'Error', httpStatus: res.status, urlCount: null }

    const xml = await res.text()
    if (!looksLikeSitemap(xml)) return { status: 'Error', httpStatus: res.status, urlCount: null }

    return { status: 'OK', httpStatus: res.status, urlCount: countLocs(xml) }
  } catch {
    return { status: 'Error', httpStatus: null, urlCount: null }
  }
}

export async function checkProjectHealth(project: {
  id: number
  name: string
  domain: string
}): Promise<ProjectHealth> {
  const origin = project.domain.replace(/\/+$/, '')
  const [site, sitemap] = await Promise.all([checkSite(origin), checkSitemap(origin)])

  return {
    projectId: project.id,
    projectName: project.name,
    domain: origin,
    site,
    sitemap,
    checkedAt: new Date().toISOString(),
  }
}
