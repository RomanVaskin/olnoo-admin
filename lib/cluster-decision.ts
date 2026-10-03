// What the Clusters table shows when the AI and a human both have a say. The AI layer (seo_clusters.status,
// ai_decision, suggested_*) is kept as history; the human layer (review_status, confirmed_page_id) always wins.

export type ClusterDecisionInput = {
  status: string
  reviewStatus: 'pending' | 'confirmed' | 'no_page' | 'ignored'
  confirmedPageId: number | null
  aiDecision?: 'create' | 'improve' | 'ignore' | null
}

/** Status pill: a human decision beats the AI's classification (confirmed page → «Есть страница», no_page → «Нет страницы», ignored → «Ignored»). */
export function displayStatus(c: ClusterDecisionInput): string {
  if (c.confirmedPageId != null) return 'Existing page'
  if (c.reviewStatus === 'no_page') return 'No page'
  if (c.reviewStatus === 'ignored') return 'Ignored'
  return c.status
}

/** The AI's CREATE proposal (slug / H1 / Title) is only relevant while no existing page was chosen and the cluster was not ignored. */
export function showCreateSuggestion(c: ClusterDecisionInput): boolean {
  return c.aiDecision === 'create' && c.confirmedPageId == null && (c.reviewStatus === 'pending' || c.reviewStatus === 'no_page')
}
