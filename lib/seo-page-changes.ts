// SEO before/after tracking (roadmap step F) on the EXISTING `page_changes` table (migration 0019; no new table, no scheduler).
//   SEO Executor `pr_created` → ONE page_change per PR (kind 'fix') with the latest EXISTING Observer snapshot as the baseline;
//   a manual Observer run checks whether the PR is MERGED (GitHub, no polling) and only then does the first snapshot taken after
//   the merge become `after_snapshot_id`.
// Nothing here calls an external API or the model; it only reads/writes the database. Webmaster (queries) and Metrika (landing pages)
// stay separate sources: a query is never attributed to a page. kind 'improve' is supported by the store, but nothing registers it
// automatically (OLNOO has no Improve PR flow yet). Pure SQL helpers over an injectable `db`, no `@/` imports.
import type { Queryable } from './projects-registry.ts'

export type ChangeKind = 'fix' | 'improve'
export type SnapshotPair = { provider: string; kind: string }
const WEBMASTER_QUERIES: SnapshotPair = { provider: 'yandex_webmaster', kind: 'queries' }
const METRIKA_PAGES: SnapshotPair = { provider: 'yandex_metrika', kind: 'organic_pages' }

/** Which snapshot kind describes the change best: a change tied to ONE page → that page's organic visits; project-level → search queries. */
export function snapshotPreference(pageLevel: boolean): SnapshotPair[] {
  return pageLevel ? [METRIKA_PAGES, WEBMASTER_QUERIES] : [WEBMASTER_QUERIES, METRIKA_PAGES]
}

export type CreateChangeInput = {
  projectId: number
  kind: ChangeKind
  pageId?: number | null
  prUrl?: string | null
  issueCodes?: string[] | null
  clusterIds?: number[] | null
  notes?: string | null
  status?: string
}

async function latestSnapshotId(db: Queryable, projectId: number, pageLevel: boolean): Promise<number | null> {
  for (const p of snapshotPreference(pageLevel)) {
    const { rows } = await db.query(
      'SELECT id FROM seo_snapshots WHERE project_id = $1 AND provider = $2 AND kind = $3 ORDER BY taken_at DESC, id DESC LIMIT 1',
      [projectId, p.provider, p.kind],
    )
    if (rows[0]) return Number(rows[0].id)
  }
  return null
}

/**
 * Creates a change and returns its id. Idempotent by the real identifier: the same (project, pr_url) never produces a second row
 * (a repeated callback returns the existing id, created = false). Baseline = the latest EXISTING snapshot (never created here); none → NULL.
 */
export async function createPageChange(db: Queryable, input: CreateChangeInput): Promise<{ id: number; created: boolean }> {
  const prUrl = input.prUrl ?? null
  const baseline = await latestSnapshotId(db, input.projectId, input.pageId != null)
  const { rows } = await db.query(
    `INSERT INTO page_changes (project_id, page_id, kind, pr_url, cluster_ids, issue_codes, baseline_snapshot_id, status, notes)
     SELECT $1::int, $2::int, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::bigint, $8::text, $9::text
      WHERE $4::text IS NULL OR NOT EXISTS (SELECT 1 FROM page_changes WHERE project_id = $1::int AND pr_url = $4::text)
     RETURNING id`,
    [
      input.projectId, input.pageId ?? null, input.kind, prUrl,
      input.clusterIds ? JSON.stringify(input.clusterIds) : null, input.issueCodes ? JSON.stringify(input.issueCodes) : null,
      baseline, input.status ?? 'pr_created', input.notes ?? null,
    ],
  )
  if (rows[0]) return { id: Number(rows[0].id), created: true }
  const existing = await db.query('SELECT id FROM page_changes WHERE project_id = $1 AND pr_url = $2 ORDER BY id LIMIT 1', [input.projectId, prUrl])
  return { id: Number(existing.rows[0].id), created: false }
}

export type RegisterFixInput = { projectId: number; prUrl: string; issues: { code: string; url?: string | null }[] }

/**
 * Granularity: ONE change per Executor PR (one run = one commit = one PR), however many issues it fixed. page_id is set only when
 * every issue is a page issue of ONE known page (exact `pages.url` match); project-level or multi-page → NULL (the issues stay in
 * issue_codes / notes).
 */
export async function registerFixChange(db: Queryable, input: RegisterFixInput): Promise<{ id: number; created: boolean }> {
  const urls = [...new Set(input.issues.map((i) => i.url).filter((u): u is string => !!u))]
  let pageId: number | null = null
  if (urls.length === 1 && input.issues.every((i) => !!i.url)) {
    const { rows } = await db.query('SELECT id FROM pages WHERE project_id = $1 AND url = $2 LIMIT 1', [input.projectId, urls[0]])
    if (rows[0]) pageId = Number(rows[0].id)
  }
  return createPageChange(db, {
    projectId: input.projectId,
    kind: 'fix',
    pageId,
    prUrl: input.prUrl,
    issueCodes: [...new Set(input.issues.map((i) => i.code))].sort(),
    notes: input.issues.map((i) => (i.url ? `${i.code} ${i.url}` : i.code)).join('; ').slice(0, 1000),
  })
}

export type PrState = { merged: boolean; mergedAt: string | null }
/** Reads the state of ONE pull request. Returns null when it cannot be determined (GitHub unavailable, no access, bad URL). */
export type PrStateReader = (prUrl: string) => Promise<PrState | null>

const MAX_PR_LOOKUPS = 10

/**
 * Called after a successful MANUAL Observer run. The Before/After boundary is the real MERGE of the change's PR:
 *  1. for each open change (no after snapshot) whose `merged_at` is still unknown, the PR state is read through `readPr`
 *     (GitHub, one lookup per open change, no polling); not merged / unknown / any error → nothing is linked for that change;
 *  2. a merged PR gets `merged_at` saved (status 'merged');
 *  3. only then the FIRST snapshot with `taken_at` > `merged_at`, same provider/kind as the baseline (no baseline → the usual preference),
 *     becomes `after_snapshot_id`. Older snapshots never qualify; an already linked change is never rewritten.
 * A change without a PR URL cannot be placed in time and stays open. Returns how many changes were linked. Never throws for GitHub problems.
 */
export async function linkAfterSnapshots(db: Queryable, projectId: number, readPr: PrStateReader): Promise<number> {
  const { rows: open } = await db.query(
    `SELECT pc.id, pc.page_id, pc.pr_url, pc.merged_at, bs.provider AS b_provider, bs.kind AS b_kind
       FROM page_changes pc LEFT JOIN seo_snapshots bs ON bs.id = pc.baseline_snapshot_id
      WHERE pc.project_id = $1 AND pc.after_snapshot_id IS NULL ORDER BY pc.id`,
    [projectId],
  )

  // Step 1–2: learn (and store) the merge time of changes that do not have it yet.
  const unknown = open.filter((c) => c.merged_at == null && c.pr_url).slice(0, MAX_PR_LOOKUPS)
  const found = new Map<number, Date>()
  await Promise.all(
    unknown.map(async (c) => {
      try {
        const st = await readPr(c.pr_url as string)
        const at = st?.merged && st.mergedAt ? new Date(st.mergedAt) : null
        if (at && !Number.isNaN(at.getTime())) found.set(Number(c.id), at)
      } catch {
        // GitHub problem: the change simply stays open until the next manual run
      }
    }),
  )
  for (const [id, at] of found) {
    await db.query("UPDATE page_changes SET merged_at = $1, status = 'merged' WHERE id = $2 AND merged_at IS NULL AND after_snapshot_id IS NULL", [at.toISOString(), id])
  }

  // Step 3: after-snapshots, only for changes whose merge time is known.
  let linked = 0
  for (const c of open) {
    const mergedAt = c.merged_at != null ? new Date(c.merged_at as string | Date) : found.get(Number(c.id))
    if (!mergedAt) continue
    const pairs: SnapshotPair[] = c.b_provider ? [{ provider: c.b_provider as string, kind: c.b_kind as string }] : snapshotPreference(c.page_id != null)
    for (const p of pairs) {
      const { rows } = await db.query(
        'SELECT id FROM seo_snapshots WHERE project_id = $1 AND provider = $2 AND kind = $3 AND taken_at > $4 ORDER BY taken_at ASC, id ASC LIMIT 1',
        [projectId, p.provider, p.kind, mergedAt.toISOString()],
      )
      if (!rows[0]) continue
      const res = await db.query("UPDATE page_changes SET after_snapshot_id = $1, status = 'after_linked' WHERE id = $2 AND after_snapshot_id IS NULL RETURNING id", [rows[0].id, c.id])
      if (res.rows[0]) linked++
      break
    }
  }
  return linked
}

// ---- read model ---------------------------------------------------------------------------------------------------------

export type Metrics = { impressions?: number; clicks?: number; avgPosition?: number | null; visits?: number; pageVisits?: number | null }
export type SnapshotRef = { id: number; provider: string; kind: string; dateFrom: string; dateTo: string; takenAt: string }
export type Comparison = { provider: string; kind: string; before: Metrics; after: Metrics; overlap: boolean }
export type PageChangeView = {
  id: number
  kind: string
  status: string | null
  pageId: number | null
  pageUrl: string | null
  prUrl: string | null
  mergedAt: string | null
  createdAt: string
  issueCodes: string[]
  clusterIds: number[]
  notes: string | null
  baseline: SnapshotRef | null
  after: SnapshotRef | null
  comparison: Comparison | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Totals of the metrics a snapshot really has. Webmaster rows: project-wide impressions / clicks / impression-weighted average position
 * (NEVER per page). Metrika rows: total organic visits and, for a page-level change, the visits of that exact URL (null = not in the stored rows).
 */
export function summarizeRows(provider: string, kind: string, rows: unknown[], pageUrl: string | null): Metrics {
  const list = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
  if (provider === 'yandex_webmaster' && kind === 'queries') {
    let impressions = 0, clicks = 0, posWeight = 0, posSum = 0
    for (const r of list) {
      const i = num(r.impressions), c = num(r.clicks), p = num(r.avgPosition)
      if (i !== null) impressions += i
      if (c !== null) clicks += c
      if (i !== null && i > 0 && p !== null) { posWeight += i; posSum += p * i }
    }
    return { impressions, clicks, avgPosition: posWeight > 0 ? Number((posSum / posWeight).toFixed(1)) : null }
  }
  if (provider === 'yandex_metrika' && kind === 'organic_pages') {
    let visits = 0
    let pageVisits: number | null = null
    for (const r of list) {
      const v = num(r.visits)
      if (v !== null) visits += v
      if (pageUrl && r.url === pageUrl && v !== null) pageVisits = (pageVisits ?? 0) + v
    }
    return pageUrl ? { visits, pageVisits } : { visits }
  }
  return {}
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v))
const day = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10))

/** Newest changes first. Reads only the database. The comparison exists only when both snapshots exist and are the same provider/kind. */
export async function listPageChanges(db: Queryable, projectId: number, limit = 50): Promise<PageChangeView[]> {
  const { rows } = await db.query(
    `SELECT pc.id, pc.kind, pc.status, pc.page_id, p.url AS page_url, pc.pr_url, pc.merged_at, pc.created_at, pc.issue_codes, pc.cluster_ids, pc.notes,
            pc.baseline_snapshot_id, pc.after_snapshot_id
       FROM page_changes pc LEFT JOIN pages p ON p.id = pc.page_id
      WHERE pc.project_id = $1 ORDER BY pc.created_at DESC, pc.id DESC LIMIT $2`,
    [projectId, limit],
  )
  const ids = [...new Set(rows.flatMap((r) => [r.baseline_snapshot_id, r.after_snapshot_id]).filter((x) => x != null).map(Number))]
  const snaps = new Map<number, { ref: SnapshotRef; rows: unknown[] }>()
  if (ids.length) {
    const res = await db.query('SELECT id, provider, kind, date_from, date_to, taken_at, rows FROM seo_snapshots WHERE id = ANY($1::bigint[])', [ids])
    for (const s of res.rows) {
      snaps.set(Number(s.id), { ref: { id: Number(s.id), provider: s.provider as string, kind: s.kind as string, dateFrom: day(s.date_from), dateTo: day(s.date_to), takenAt: iso(s.taken_at) as string }, rows: (s.rows as unknown[]) ?? [] })
    }
  }
  return rows.map((r): PageChangeView => {
    const b = r.baseline_snapshot_id != null ? snaps.get(Number(r.baseline_snapshot_id)) ?? null : null
    const a = r.after_snapshot_id != null ? snaps.get(Number(r.after_snapshot_id)) ?? null : null
    const pageUrl = (r.page_url as string | null) ?? null
    const anchor = (iso(r.merged_at) ?? iso(r.created_at)) as string
    const comparison: Comparison | null =
      b && a && b.ref.provider === a.ref.provider && b.ref.kind === a.ref.kind
        ? {
            provider: b.ref.provider,
            kind: b.ref.kind,
            before: summarizeRows(b.ref.provider, b.ref.kind, b.rows, pageUrl),
            after: summarizeRows(a.ref.provider, a.ref.kind, a.rows, pageUrl),
            overlap: a.ref.dateFrom <= anchor.slice(0, 10),
          }
        : null
    return {
      id: Number(r.id),
      kind: r.kind as string,
      status: (r.status as string | null) ?? null,
      pageId: r.page_id == null ? null : Number(r.page_id),
      pageUrl,
      prUrl: (r.pr_url as string | null) ?? null,
      mergedAt: iso(r.merged_at),
      createdAt: iso(r.created_at) as string,
      issueCodes: Array.isArray(r.issue_codes) ? (r.issue_codes as string[]) : [],
      clusterIds: Array.isArray(r.cluster_ids) ? (r.cluster_ids as number[]) : [],
      notes: (r.notes as string | null) ?? null,
      baseline: b?.ref ?? null,
      after: a?.ref ?? null,
      comparison,
    }
  })
}
