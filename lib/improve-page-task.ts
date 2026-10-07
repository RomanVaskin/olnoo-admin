// "Improve page" = ONE task per existing page, built from ALL clusters of the project that are
// human-confirmed (review_status = confirmed) for that page (confirmed_page_id = page.id).
// Pure — no DB/network — so every "Улучшить страницу" button yields the same prompt for a page.

import {
  buildImproveTask,
  DEFAULT_TASK_LOCALE,
  normalizeTaskLocale,
  type TaskAnalyticsCluster,
  type TaskCluster,
  type TaskLocale,
  type TaskPage,
  type TaskProject,
} from './seo-task-generator.ts'
import { clusterLocale, pageLocale, type ClusterPageInput, type PageOption } from './cluster-pages.ts'

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

/**
 * Intents kept out of the Improve content scope: navigational clusters (third-party brands, other
 * sites) stay bound to the page for analytics but must not become mandatory coverage. Decided by the
 * stored `intent` only — never by cluster/keyword names. Commercial etc. stay in scope.
 */
const ANALYTICS_ONLY_INTENTS = new Set(['navigational'])

export function isContentScopeCluster(c: { intent: string }): boolean {
  return !ANALYTICS_ONLY_INTENTS.has(c.intent)
}

/** Returns null when the page has no confirmed cluster in the content scope (nothing to improve for). */
export function buildImproveTaskForPage(
  project: TaskProject,
  clusters: ImproveClusterInput[],
  pages: PageOption[],
  pageId: number,
): string | null {
  const confirmed = clustersConfirmedForPage(clusters, pageId)
  const group = confirmed.filter(isContentScopeCluster)
  if (group.length === 0) return null
  const analyticsOnly: TaskAnalyticsCluster[] = confirmed
    .filter((c) => !isContentScopeCluster(c))
    .map((c) => ({ name: c.name, intent: c.intent, totalFrequency: c.totalFrequency }))

  const matched = pages.find((p) => p.id === pageId)
  const page: TaskPage = matched
    ? { url: matched.url, title: matched.title, h1: matched.h1, description: matched.description, locale: matched.locale }
    : { url: group[0].confirmedPageUrl ?? '', title: null, h1: null, description: null, locale: null }

  // Language of the task, in order: the target page's own language (URL prefix, then stored locale); the project's default
  // language (`projects.locale`, passed in `project.locale`); the clusters' language (first cluster that has one); then the
  // safe default. The language is only a label of the task: nothing here branches on it and no URL prefix is required.
  const locale: TaskLocale =
    (matched ? pageLocale(matched) : null) ??
    normalizeTaskLocale(project.locale) ??
    normalizeTaskLocale(group.map((c) => clusterLocale(c, pages)).find((l) => l != null)) ??
    DEFAULT_TASK_LOCALE
  const taskClusters: TaskCluster[] = group.map((c) => ({
    name: c.name,
    primaryKeyword: c.primaryKeyword,
    intent: c.intent,
    totalFrequency: c.totalFrequency,
    keywords: c.keywords.map((k) => ({ query: k.query, frequency: k.frequency })),
  }))
  return buildImproveTask(project, taskClusters, page, locale, analyticsOnly)
}
