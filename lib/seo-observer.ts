// SEO Observer v1 (roadmap step C): a MANUAL, read-only snapshot of a project's search performance.
//   Yandex Webmaster popular queries (impressions / clicks / CTR / average position)  → seo_snapshots (yandex_webmaster / queries)
//   Yandex Metrika organic landing pages (visits)                                      → seo_snapshots (yandex_metrika / organic_pages)
// The two sets are stored SEPARATELY: Webmaster does not split queries by URL, so a query is never joined to a page here.
// No scheduler, no queue, no recommendations, no writes to any provider. One project per run; each provider is independent.
import { resolveObserverPeriod, moscowDay, type ResolvedPeriod } from './observer-period.ts'
import type { Queryable } from './projects-registry.ts'
import { METRIKA_PROJECTS, MetrikaApiError, type createMetrikaClient } from './yandex-metrika.ts'
import { WebmasterApiError, type QueryRow, type createWebmasterClient } from './yandex-webmaster.ts'

export const OBSERVER_DAYS = 28

export type ObserverProvider = 'yandex_webmaster' | 'yandex_metrika'
export type ObserverKind = 'queries' | 'organic_pages'
export type PageRow = { path: string; url: string; visits: number }

export type ObserverProject = { id: number; slug: string | null; domain: string }

export type SnapshotData<R> = { provider: ObserverProvider; kind: ObserverKind; dateFrom: string; dateTo: string; rows: R[] }

/** The standard v1 period: the last 28 COMPLETE Moscow days (yesterday backwards; the unfinished current day is excluded). */
export function observerPeriod(now: Date = new Date()): ResolvedPeriod {
  const p = resolveObserverPeriod(new URLSearchParams({ from: moscowDay(now, OBSERVER_DAYS), to: moscowDay(now, 1) }), now)
  if ('error' in p) throw new Error(p.error)
  return p
}

/** `https://domain` + landing path, built safely: anything that would leave the project's origin is dropped (null). */
export function buildPageUrl(domain: string, path: string): string | null {
  try {
    const origin = new URL(domain).origin
    if (!path.startsWith('/') || path.startsWith('//')) return null
    const url = new URL(path, origin)
    return url.origin === origin ? url.toString() : null
  } catch {
    return null
  }
}

// ---- providers -------------------------------------------------------------------------------------------------------

type WebmasterClient = Pick<ReturnType<typeof createWebmasterClient>, 'popularQueries'>
type MetrikaClient = Pick<ReturnType<typeof createMetrikaClient>, 'observeOrganicPages'>

export async function getSeoQuerySnapshot(project: ObserverProject, period: ResolvedPeriod, client: WebmasterClient): Promise<SnapshotData<QueryRow>> {
  const rows = await client.popularQueries(project.domain, { from: period.from, to: period.to })
  return { provider: 'yandex_webmaster', kind: 'queries', dateFrom: period.from, dateTo: period.to, rows }
}

export async function getOrganicPagesSnapshot(project: ObserverProject, period: ResolvedPeriod, client: MetrikaClient): Promise<SnapshotData<PageRow>> {
  const paths = await client.observeOrganicPages(project.slug ?? '', period)
  const rows: PageRow[] = []
  for (const r of paths) {
    const url = buildPageUrl(project.domain, r.path)
    if (url) rows.push({ path: r.path, url, visits: r.visits })
  }
  return { provider: 'yandex_metrika', kind: 'organic_pages', dateFrom: period.from, dateTo: period.to, rows }
}

// ---- storage ---------------------------------------------------------------------------------------------------------

export type StoredSnapshot = {
  id: number
  provider: ObserverProvider
  kind: ObserverKind
  dateFrom: string
  dateTo: string
  takenAt: string
  rows: unknown[]
}

export async function saveSeoSnapshot(db: Queryable, projectId: number, data: SnapshotData<unknown>): Promise<number> {
  const { rows } = await db.query(
    'INSERT INTO seo_snapshots (project_id, provider, kind, date_from, date_to, rows) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id',
    [projectId, data.provider, data.kind, data.dateFrom, data.dateTo, JSON.stringify(data.rows)],
  )
  return Number(rows[0].id)
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v))
const day = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10))

/** The newest stored snapshot per (provider, kind) of a project. Reads only the database — never an external API. */
export async function getLatestSeoSnapshots(db: Queryable, projectId: number): Promise<StoredSnapshot[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (provider, kind) id, provider, kind, date_from, date_to, taken_at, rows
       FROM seo_snapshots WHERE project_id = $1
      ORDER BY provider, kind, taken_at DESC, id DESC`,
    [projectId],
  )
  return rows.map((r) => ({ id: Number(r.id), provider: r.provider as ObserverProvider, kind: r.kind as ObserverKind, dateFrom: day(r.date_from), dateTo: day(r.date_to), takenAt: iso(r.taken_at), rows: (r.rows as unknown[]) ?? [] }))
}

// ---- manual run ------------------------------------------------------------------------------------------------------

export type SourceState =
  | { status: 'ok'; snapshotId: number; rows: number }
  | { status: 'not_configured'; reason: string }
  | { status: 'error'; kind: string; message: string }

export type ObserverRun = {
  projectId: number
  dateFrom: string
  dateTo: string
  takenAt: string
  /** true when at least one source succeeded and at least one did not. */
  partial: boolean
  webmaster: SourceState
  metrika: SourceState
}

export type ObserverDeps = {
  /** null = the provider has no credentials. */
  webmaster: WebmasterClient | null
  metrika: MetrikaClient | null
  now?: () => Date
}

/** Maps a provider failure to a state. Only the error KIND and a short fixed message leave this function — never a token or a body. */
function failure(err: unknown): SourceState {
  if (err instanceof WebmasterApiError) {
    if (err.kind === 'host_not_found' || err.kind === 'not_configured') return { status: 'not_configured', reason: err.kind }
    return { status: 'error', kind: err.kind, message: err.message }
  }
  if (err instanceof MetrikaApiError) {
    if (err.kind === 'not_configured' || err.kind === 'unknown_project') return { status: 'not_configured', reason: err.kind }
    return { status: 'error', kind: err.kind, message: err.message }
  }
  return { status: 'error', kind: 'internal', message: 'unexpected failure' }
}

/**
 * One project, one manual run. Each provider is read and saved on its own: a failure (or a missing configuration) of one never
 * rolls back or blocks the other, and nothing — no empty "fake" snapshot — is saved for a provider that did not answer.
 */
export async function runSeoObserver(db: Queryable, project: ObserverProject, deps: ObserverDeps): Promise<ObserverRun> {
  const now = (deps.now ?? (() => new Date()))()
  const period = observerPeriod(now)

  async function source<R>(client: unknown, read: () => Promise<SnapshotData<R>>, notConfiguredReason: string): Promise<SourceState> {
    if (!client) return { status: 'not_configured', reason: notConfiguredReason }
    try {
      const data = await read()
      return { status: 'ok', snapshotId: await saveSeoSnapshot(db, project.id, data), rows: data.rows.length }
    } catch (err) {
      return failure(err)
    }
  }

  const [webmaster, metrika] = await Promise.all([
    source(deps.webmaster, () => getSeoQuerySnapshot(project, period, deps.webmaster!), 'no_token'),
    source(
      project.slug && Object.prototype.hasOwnProperty.call(METRIKA_PROJECTS, project.slug) ? deps.metrika : null,
      () => getOrganicPagesSnapshot(project, period, deps.metrika!),
      deps.metrika ? 'no_counter_for_project' : 'no_token',
    ),
  ])
  const ok = [webmaster, metrika].filter((s) => s.status === 'ok').length
  return { projectId: project.id, dateFrom: period.from, dateTo: period.to, takenAt: now.toISOString(), partial: ok === 1, webmaster, metrika }
}
