// "Improve page" = ONE task per existing page, built from ALL clusters of the project that are
// human-confirmed (review_status = confirmed) for that page (confirmed_page_id = page.id).
// Pure — no DB/network — so every "Улучшить страницу" button yields the same prompt for a page.

import { buildImproveTask, type TaskCluster, type TaskLocale, type TaskPage, type TaskProject } from './seo-task-generator.ts'
import { clusterLocale, type ClusterPageInput, type PageOption } from './cluster-pages.ts'

export type ImproveClusterInput = ClusterPageInput &
  TaskCluster & {
    id: number
    reviewStatus: string
    confirmedPageId: number | null
    confirmedPageUrl: string | null
  }

/** Confirmed clusters of one page, in a deterministic order (frequency desc, then name, then id). */
export function clustersConfirmedForPage<T extends ImproveClusterInput>(clusters: T[], pageId: number): T[] {
  return clusters
    .filter((c) => c.reviewStatus === 'confirmed' && c.confirmedPageId === pageId)
    .sort(
      (a, b) =>
        (b.totalFrequency ?? 0) - (a.totalFrequency ?? 0) || a.name.localeCompare(b.name) || a.id - b.id,
    )
}

/** Returns null when no cluster is confirmed for the page. */
export function buildImproveTaskForPage(
  project: TaskProject,
  clusters: ImproveClusterInput[],
  pages: PageOption[],
  pageId: number,
): string | null {
  const group = clustersConfirmedForPage(clusters, pageId)
  if (group.length === 0) return null

  const matched = pages.find((p) => p.id === pageId)
  const page: TaskPage = matched
    ? { url: matched.url, title: matched.title, h1: matched.h1, description: matched.description, locale: matched.locale }
    : { url: group[0].confirmedPageUrl ?? '', title: null, h1: null, description: null, locale: null }

  const locale: TaskLocale = clusterLocale(group[0], pages) === 'ru' ? 'ru' : 'en'
  const taskClusters: TaskCluster[] = group.map((c) => ({
    name: c.name,
    primaryKeyword: c.primaryKeyword,
    intent: c.intent,
    totalFrequency: c.totalFrequency,
    keywords: c.keywords.map((k) => ({ query: k.query, frequency: k.frequency })),
  }))
  return buildImproveTask(project, taskClusters, page, locale)
}
