// Page matching for SEO → Clusters («Найти существующую» and Recommended pages): client-side only, no API.
// Language rule: a page whose language is unknown (no /ru/-style prefix and no stored locale — e.g. DriveSet's
// /polirovka-avto) is NEUTRAL and is offered to a cluster of any language; a page that is explicitly RU never
// goes to an EN cluster and vice versa.

export type PageOption = {
  id: number
  url: string
  locale: string | null
  title: string | null
  h1: string | null
  description: string | null
}

/** The cluster fields the page matching reads. */
export type ClusterPageInput = {
  name: string
  primaryKeyword: string | null
  recommendedPageId: number | null
  recommendedPageUrl: string | null
}

export function pagePath(url: string) {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

// Mirrors the prefix detection in lib/html-extract.ts, which is what populates pages.locale
// during sync — kept in sync so a URL prefix and the stored locale never disagree here.
const LOCALE_PREFIXES = new Set(['ru', 'en', 'kk', 'kz'])

export function urlLocale(url: string): string | null {
  const prefix = pagePath(url).match(/^\/([a-z]{2})(\/|$)/i)?.[1]?.toLowerCase()
  return prefix && LOCALE_PREFIXES.has(prefix) ? prefix : null
}

/** A page's language: its URL prefix (/ru/…) takes priority, falling back to the stored locale column. */
export function pageLocale(p: PageOption): string | null {
  return urlLocale(p.url) ?? (p.locale ? p.locale.toLowerCase() : null)
}

/**
 * A cluster's language, used to filter page search results so an RU cluster only offers RU
 * pages (and vice versa). Prefers the AI-recommended page's language — the most reliable
 * signal — and only falls back to guessing from the primary keyword's script when no
 * recommendation exists. Never derived from confirmedPageId: a previously mis-confirmed page
 * must not bias the language filter.
 */
export function clusterLocale(c: ClusterPageInput, pages: PageOption[]): string | null {
  if (c.recommendedPageId != null) {
    const recommended = pages.find((p) => p.id === c.recommendedPageId)
    const loc = recommended ? pageLocale(recommended) : c.recommendedPageUrl ? urlLocale(c.recommendedPageUrl) : null
    if (loc) return loc
  }
  if (c.primaryKeyword) return /[Ѐ-ӿ]/.test(c.primaryKeyword) ? 'ru' : 'en'
  return null
}

/**
 * Pages offered to a cluster of language `clusterLoc`: pages of the same language plus language-neutral ones
 * (`pageLocale === null`). Explicitly other-language pages are excluded. Unknown cluster language → all pages.
 */
export function pagesForLocale(pages: PageOption[], clusterLoc: string | null): PageOption[] {
  if (!clusterLoc) return pages
  return pages.filter((p) => {
    const loc = pageLocale(p)
    return loc === null || loc === clusterLoc
  })
}

/**
 * Ranks a page against a search query: exact match (0) beats prefix match (1) beats substring
 * match (2); anything else is excluded. Checked against URL, title, and H1 — whichever the page
 * has. Deliberately simple (no fuzzy-matching library) per the search requirements.
 */
function pageMatchScore(p: PageOption, query: string): number | null {
  const fields = [p.url, pagePath(p.url), p.title, p.h1]
    .filter((v): v is string => !!v)
    .map((v) => v.toLowerCase())
  if (fields.some((f) => f === query)) return 0
  if (fields.some((f) => f.startsWith(query))) return 1
  if (fields.some((f) => f.includes(query))) return 2
  return null
}

/** Reusable page search: filters an already-loaded, locale-scoped page list client-side, max 10 results. */
export function searchPages(pages: PageOption[], query: string): PageOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return pages
    .map((p) => ({ p, score: pageMatchScore(p, q) }))
    .filter((x): x is { p: PageOption; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.p.url.localeCompare(b.p.url))
    .slice(0, 10)
    .map((x) => x.p)
}

/** Best (lowest) pageMatchScore across several query strings — used to rank a page against both the primary keyword and the cluster name at once. */
function clusterMatchScore(p: PageOption, queries: string[]): number | null {
  let best: number | null = null
  for (const raw of queries) {
    const q = raw.trim().toLowerCase()
    if (!q) continue
    const score = pageMatchScore(p, q)
    if (score !== null && (best === null || score < best)) best = score
  }
  return best
}

/**
 * Up to 3 "Recommended pages" for a cluster, client-side only — no new AI call, no new API. The
 * AI recommendation (if any) always leads; the remaining slots are filled from the already-loaded,
 * locale-matching page list, ranked by relevance of the primary keyword + cluster name against
 * URL/title/H1 (exact > startsWith > includes, per pageMatchScore). Never duplicates a page.
 */
export function getRecommendedPages(c: ClusterPageInput, pages: PageOption[]): PageOption[] {
  const result: PageOption[] = []
  const seen = new Set<number>()

  const aiPick = c.recommendedPageId != null ? pages.find((p) => p.id === c.recommendedPageId) : undefined
  if (aiPick) {
    result.push(aiPick)
    seen.add(aiPick.id)
  }

  const clusterLoc = clusterLocale(c, pages)
  const localePages = pagesForLocale(pages, clusterLoc)
  const queries = [c.primaryKeyword, c.name].filter((v): v is string => !!v)

  if (queries.length > 0) {
    const ranked = localePages
      .filter((p) => !seen.has(p.id))
      .map((p) => ({ p, score: clusterMatchScore(p, queries) }))
      .filter((x): x is { p: PageOption; score: number } => x.score !== null)
      .sort((a, b) => a.score - b.score || a.p.url.localeCompare(b.p.url))

    for (const { p } of ranked) {
      if (result.length >= 3) break
      result.push(p)
      seen.add(p.id)
    }
  }

  return result
}

