// READ-ONLY loader of the Decision rules inputs: last Technical SEO result, latest Observer snapshots, saved clusters, pages and
// keyword relevance. Issues SELECTs only — no writes anywhere.
import type { Pool } from 'pg'
import { buildDecisionInput, type DecisionSources } from './seo-decision-input.ts'
import { decideSeoActions, type SeoDecision } from './seo-decision-rules.ts'
import { getLatestSeoSnapshots } from './seo-observer.ts'
import { readLastResult } from './seo-health-store.ts'
import { listClustersForProject } from './seo-clustering.ts'

async function loadRelevance(pool: Pool, clusterKeywordIds: number[]): Promise<Map<number, string | null>> {
  const map = new Map<number, string | null>()
  if (clusterKeywordIds.length === 0) return map
  try {
    const { rows } = await pool.query('SELECT id, relevance_status FROM keywords WHERE id = ANY($1::int[])', [clusterKeywordIds])
    for (const r of rows) map.set(r.id as number, (r.relevance_status as string | null) ?? null)
  } catch (err) {
    // Migration 0012 not applied: relevance is simply unknown (never "irrelevant").
    if ((err as { code?: string }).code !== '42703') throw err
  }
  return map
}

export type SeoDecisionResult = {
  projectId: number
  /** When each input was produced (null = that input does not exist yet). */
  inputs: { technicalCheckedAt: string | null; webmasterTakenAt: string | null; metrikaTakenAt: string | null }
  decisions: SeoDecision[]
}

export async function computeSeoDecisions(pool: Pool, projectId: number): Promise<SeoDecisionResult> {
  const [health, snapshots, clusters, pages] = await Promise.all([
    readLastResult(pool, projectId),
    getLatestSeoSnapshots(pool, projectId),
    listClustersForProject(pool, projectId),
    pool.query('SELECT id, url FROM pages WHERE project_id = $1 ORDER BY id', [projectId]),
  ])
  const keywordIds = [...new Set(clusters.flatMap((c) => c.keywords.map((k) => k.id)))]
  const src: DecisionSources = {
    projectId,
    technicalIssues: health ? health.issues.map((i) => ({ code: i.code, url: i.url ?? null })) : null,
    snapshots,
    clusters,
    pages: pages.rows.map((p) => ({ id: p.id as number, url: p.url as string })),
    relevanceByKeywordId: await loadRelevance(pool, keywordIds),
  }
  const at = (provider: string) => snapshots.find((s) => s.provider === provider)?.takenAt ?? null
  return {
    projectId,
    inputs: { technicalCheckedAt: health?.checkedAt ?? null, webmasterTakenAt: at('yandex_webmaster'), metrikaTakenAt: at('yandex_metrika') },
    decisions: decideSeoActions(buildDecisionInput(src)),
  }
}
