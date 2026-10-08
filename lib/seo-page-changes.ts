// SEO Before/After tracking v1 (roadmap step F) on the EXISTING `page_changes` table (migration 0019, no new schema):
//   SEO change → PR → baseline snapshot → a later manual Observer snapshot → before/after.
// Pure SQL helpers over an injectable `db` + one pure comparison (no `@/` imports), so it runs under `node --test`.
// No scheduler, no GitHub polling, no AI. Webmaster queries and Metrika landing pages stay SEPARATE sources: a query is never joined to a page.
import type { Queryable } from './projects-registry.ts'
import type { Issue } from './seo-health.ts'

export type ChangeKind = 'fix' | 'improve'
export type SnapshotRef = { id: number; provider: string; kind: string }

/** Granularity of ONE page_change: one PR × one target. Target = a known page (exact `pages.url` match) or project-level (page_id NULL:
 * project-wide issues such as robots_missing, and issues whose URL is not a known page). Several issues of the same target share one row. */
export type FixChangeInput = { projectId: number; prUrl: string; issues: readonly Pick<Issue, 'code' | 'url'>[] }

/** Preference for the single baseline/after snapshot of a change: a page-level change prefers the Metrika page list (the page's own visits),
 * a project-level change prefers the Webmaster query totals. The other source is the fallback. */
const PREFERENCE = {
  page: [['yandex_metrika', 'organic_pages'], ['yandex_webmaster', 'queries']],
  project: [['yandex_webmaster', 'queries'], ['yandex_metrika', 'organic_pages']],
} as const

function pickByPreference<T extends { provider: string; kind: string }>(candidates: readonly T[], hasPage: boolean): T | null {
  for (const [provider, kind] of PREFERENCE[hasPage ? 'page' : 'project']) {
    const hit = candidates.find((c) => c.provider === provider && c.kind === kind)
    if (hit) return hit
  }
  return null
}

/** The newest ALREADY STORED snapshot per (provider, kind) of a project, ids only. Nothing is created for a baseline. */
async function latestSnapshotRefs(db: Queryable, projectId: number): Promise<SnapshotRef[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (provider, kind) id, provider, kind FROM seo_snapshots WHERE project_id = $1 ORDER BY provider, kind, taken_at DESC, id DESC`,
    [projectId],
  )
  return rows.map((r) => ({ id: Number(r.id), provider: String(r.provider), kind: String(r.kind) }))
}

/**
 * Registers a change after the Executor opened a PR. Idempotent: an existing row for the same (project, kind, pr_url, page) is kept,
 * so a repeated call for the same PR never duplicates. Returns the ids of the rows that were CREATED.
 */
export async function recordFixChanges(db: Queryable, input: FixChangeInput, kind: ChangeKind = 'fix'): Promise<number[]> {
  const urls = [...new Set(input.issues.map((i) => i.url).filter((u): u is string => !!u))]
  const pageIds = new Map<string, number>()
  if (urls.length) {
    const { rows } = await db.query('SELECT id, url FROM pages WHERE project_id = $1 AND url = ANY($2::text[])', [input.projectId, urls])
    for (const r of rows) pageIds.set(String(r.url), Number(r.id))
  }
  const groups = new Map<number | null, Set<string>>()
  for (const i of input.issues) {
    const pageId = i.url ? (pageIds.get(i.url) ?? null) : null
    if (!groups.has(pageId)) groups.set(pageId, new Set())
    groups.get(pageId)!.add(i.code)
  }
  const refs = await latestSnapshotRefs(db, input.projectId)
  const created: number[] = []
  for (const [pageId, codes] of groups) {
    const dup = await db.query(
      'SELECT id FROM page_changes WHERE project_id = $1 AND kind = $2 AND pr_url = $3 AND page_id IS NOT DISTINCT FROM $4::int LIMIT 1',
      [input.projectId, kind, input.prUrl, pageId],
    )
    if (dup.rows.length) continue
    const baseline = pickByPreference(refs, pageId !== null)
    created.push(await createPageChange(db, { projectId: input.projectId, kind, pageId, prUrl: input.prUrl, issueCodes: [...codes].sort(), baselineSnapshotId: baseline?.id ?? null }))
  }
  return created
}

/**
 * After a successful manual Observer run: for every OPEN change of the project (no after snapshot) link a NEW snapshot that was taken
 * AFTER the change boundary (merged_at, else created_at = PR creation time) and has the baseline's provider/kind (without a baseline: the
 * same preference as for the baseline). An older snapshot never becomes `after`. Returns the ids of the changes that were closed.
 */
export async function linkAfterSnapshots(db: Queryable, projectId: number, newSnapshotIds: readonly number[]): Promise<number[]> {
  if (newSnapshotIds.length === 0) return []
  const fresh = await db.query('SELECT id, provider, kind, taken_at FROM seo_snapshots WHERE project_id = $1 AND id = ANY($2::bigint[])', [projectId, [...newSnapshotIds]])
  if (fresh.rows.length === 0) return []
  const open = await db.query(
    `SELECT c.id, c.page_id, c.merged_at, c.created_at, b.provider AS b_provider, b.kind AS b_kind
       FROM page_changes c LEFT JOIN seo_snapshots b ON b.id = c.baseline_snapshot_id
      WHERE c.project_id = $1 AND c.after_snapshot_id IS NULL ORDER BY c.id`,
    [projectId],
  )
  const closed: number[] = []
  for (const c of open.rows) {
    const boundary = new Date((c.merged_at ?? c.created_at) as string | Date).getTime()
    const eligible = fresh.rows
      .filter((s) => new Date(s.taken_at as string | Date).getTime() > boundary)
      .map((s) => ({ id: Number(s.id), provider: String(s.provider), kind: String(s.kind) }))
    const match = c.b_provider ? (eligible.find((s) => s.provider === c.b_provider && s.kind === c.b_kind) ?? null) : pickByPreference(eligible, c.page_id !== null && c.page_id !== undefined)
    if (!match) continue
    const upd = await db.query("UPDATE page_changes SET after_snapshot_id = $1, status = 'observed' WHERE id = $2 AND after_snapshot_id IS NULL RETURNING id", [match.id, c.id])
    if (upd.rows.length) closed.push(Number(c.id))
  }
  return closed
}

// ---- read model --------------------------------------------------------------------------------------------------------

export type Metrics = { impressions: number | null; clicks: number | null; avgPosition: number | null; visits: number | null }
export type SnapshotSummary = { id: number; provider: string; kind: string; dateFrom: string; dateTo: string; takenAt: string; metrics: Metrics }
export type PageChange = {
  id: number
  kind: string
  projectId: number
  pageId: number | null
  pageUrl: string | null
  prUrl: string | null
  mergedAt: string | null
  createdAt: string
  issueCodes: string[]
  clusterIds: number[]
  status: string | null
  baseline: SnapshotSummary | null
  after: SnapshotSummary | null
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v))
const day = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10))
const arr = <T,>(v: unknown): T[] => {
  const x = typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return null } })() : v
  return Array.isArray(x) ? (x as T[]) : []
}

/** Normalised metrics from stored rows. Webmaster: totals over the STORED top queries (position weighted by impressions). Metrika: the page's
 * own visits for a page-level change (exact URL), the total of the stored pages for project-level. Only what the snapshot really has. */
export function snapshotMetrics(provider: string, kind: string, rows: unknown[], pageUrl: string | null): Metrics {
  const none: Metrics = { impressions: null, clicks: null, avgPosition: null, visits: null }
  if (provider === 'yandex_webmaster' && kind === 'queries') {
    let impressions = 0, clicks = 0, weighted = 0, weight = 0
    for (const r of rows as { impressions?: unknown; clicks?: unknown; avgPosition?: unknown }[]) {
      const imp = typeof r.impressions === 'number' ? r.impressions : 0
      impressions += imp
      clicks += typeof r.clicks === 'number' ? r.clicks : 0
      if (typeof r.avgPosition === 'number' && imp > 0) { weighted += r.avgPosition * imp; weight += imp }
    }
    return { ...none, impressions, clicks, avgPosition: weight > 0 ? Math.round((weighted / weight) * 100) / 100 : null }
  }
  if (provider === 'yandex_metrika' && kind === 'organic_pages') {
    const list = rows as { url?: unknown; visits?: unknown }[]
    const visits = pageUrl ? list.filter((r) => r.url === pageUrl).reduce((s, r) => s + (typeof r.visits === 'number' ? r.visits : 0), 0) : list.reduce((s, r) => s + (typeof r.visits === 'number' ? r.visits : 0), 0)
    return { ...none, visits }
  }
  return none
}

export async function listPageChanges(db: Queryable, projectId: number): Promise<PageChange[]> {
  const { rows } = await db.query(
    `SELECT c.id, c.project_id, c.page_id, c.kind, c.pr_url, c.merged_at, c.cluster_ids, c.issue_codes, c.status, c.created_at, p.url AS page_url,
            b.id AS b_id, b.provider AS b_provider, b.kind AS b_kind, b.date_from AS b_from, b.date_to AS b_to, b.taken_at AS b_taken, b.rows AS b_rows,
            a.id AS a_id, a.provider AS a_provider, a.kind AS a_kind, a.date_from AS a_from, a.date_to AS a_to, a.taken_at AS a_taken, a.rows AS a_rows
       FROM page_changes c
       LEFT JOIN pages p ON p.id = c.page_id
       LEFT JOIN seo_snapshots b ON b.id = c.baseline_snapshot_id
       LEFT JOIN seo_snapshots a ON a.id = c.after_snapshot_id
      WHERE c.project_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 100`,
    [projectId],
  )
  return rows.map((r): PageChange => {
    const pageUrl = (r.page_url as string | null) ?? null
    const summary = (p: 'b' | 'a'): SnapshotSummary | null =>
      r[`${p}_id`] === null || r[`${p}_id`] === undefined
        ? null
        : {
            id: Number(r[`${p}_id`]), provider: String(r[`${p}_provider`]), kind: String(r[`${p}_kind`]),
            dateFrom: day(r[`${p}_from`]), dateTo: day(r[`${p}_to`]), takenAt: iso(r[`${p}_taken`]),
            metrics: snapshotMetrics(String(r[`${p}_provider`]), String(r[`${p}_kind`]), arr(r[`${p}_rows`]), pageUrl),
          }
    return {
      id: Number(r.id), kind: String(r.kind), projectId: Number(r.project_id), pageId: r.page_id === null ? null : Number(r.page_id), pageUrl,
      prUrl: (r.pr_url as string | null) ?? null, mergedAt: r.merged_at ? iso(r.merged_at) : null, createdAt: iso(r.created_at),
      issueCodes: arr<string>(r.issue_codes), clusterIds: arr<number>(r.cluster_ids), status: (r.status as string | null) ?? null,
      baseline: summary('b'), after: summary('a'),
    }
  })
}

/** Creates one change of any supported kind (`improve` is supported by the model; it has no automatic caller in v1 — future). */
export async function createPageChange(
  db: Queryable,
  c: { projectId: number; kind: ChangeKind; pageId?: number | null; prUrl?: string | null; issueCodes?: string[]; clusterIds?: number[]; baselineSnapshotId?: number | null; status?: string },
): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO page_changes (project_id, page_id, kind, pr_url, issue_codes, cluster_ids, baseline_snapshot_id, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) RETURNING id`,
    [c.projectId, c.pageId ?? null, c.kind, c.prUrl ?? null, c.issueCodes ? JSON.stringify(c.issueCodes) : null, c.clusterIds ? JSON.stringify(c.clusterIds) : null, c.baselineSnapshotId ?? null, c.status ?? 'pr_created'],
  )
  return Number(rows[0].id)
}
