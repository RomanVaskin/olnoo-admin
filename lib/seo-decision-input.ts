// Adapter for the Decision rules: turns what the app already stores (last Technical SEO result, latest Observer snapshots, saved
// clusters, pages, keyword relevance) into the plain objects `decideSeoActions` takes. Pure (no DB / network): the loading is in
// lib/seo-decision-store.ts. Nothing here changes any storage.
import type { DecisionCluster, DecisionInput, DecisionIssue, DecisionOrganicPage, DecisionPage, DecisionQueryRow } from './seo-decision-rules.ts'
import type { StoredSnapshot } from './seo-observer.ts'
import type { SavedCluster } from './seo-clustering.ts'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** yandex_webmaster / queries rows → decision rows; malformed rows are dropped. */
export function toQueryRows(rows: unknown[]): DecisionQueryRow[] {
  const out: DecisionQueryRow[] = []
  for (const r of rows) {
    const o = (r ?? {}) as Record<string, unknown>
    const impressions = num(o.impressions)
    if (typeof o.query !== 'string' || impressions === null) continue
    out.push({ query: o.query, impressions, clicks: num(o.clicks) ?? 0, avgPosition: num(o.avgPosition) })
  }
  return out
}

/** yandex_metrika / organic_pages rows → decision rows; malformed rows are dropped. */
export function toOrganicRows(rows: unknown[]): DecisionOrganicPage[] {
  const out: DecisionOrganicPage[] = []
  for (const r of rows) {
    const o = (r ?? {}) as Record<string, unknown>
    const visits = num(o.visits)
    if (typeof o.url === 'string' && visits !== null) out.push({ url: o.url, visits })
  }
  return out
}

export type DecisionSources = {
  projectId: number
  /** Saved Technical SEO issues (readLastResult(...).issues); null = never checked. */
  technicalIssues: DecisionIssue[] | null
  snapshots: StoredSnapshot[]
  clusters: SavedCluster[]
  pages: DecisionPage[]
  /** keywords.id → relevance_status (absent / null = unknown). */
  relevanceByKeywordId: ReadonlyMap<number, string | null>
}

export function buildDecisionInput(src: DecisionSources): DecisionInput {
  const webmaster = src.snapshots.find((s) => s.provider === 'yandex_webmaster' && s.kind === 'queries')
  const metrika = src.snapshots.find((s) => s.provider === 'yandex_metrika' && s.kind === 'organic_pages')
  const clusters: DecisionCluster[] = src.clusters.map((c) => ({
    id: c.id,
    name: c.name,
    intent: c.intent ?? null,
    reviewStatus: c.reviewStatus,
    confirmedPageId: c.confirmedPageId,
    keywords: c.keywords.map((k) => ({ query: k.query, relevanceStatus: src.relevanceByKeywordId.get(k.id) ?? null })),
  }))
  return {
    projectId: src.projectId,
    technicalIssues: src.technicalIssues,
    webmasterQueries: webmaster ? toQueryRows(webmaster.rows) : null,
    organicPages: metrika ? toOrganicRows(metrika.rows) : null,
    clusters,
    pages: src.pages,
  }
}
