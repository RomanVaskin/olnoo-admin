'use client'

import { Fragment, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'
import { buildCreateTask, buildImproveTask, type TaskLocale, type TaskPage } from '@/lib/seo-task-generator'

type ReviewStatus = 'pending' | 'confirmed' | 'no_page' | 'ignored'

type ClusterRow = {
  id: number
  name: string
  primaryKeywordId: number | null
  primaryKeyword: string | null
  intent: string
  totalFrequency: number | null
  recommendedPageId: number | null
  recommendedPageUrl: string | null
  confidence: number | null
  needsNewPage: boolean
  reason: string | null
  status: string
  confirmedPageId: number | null
  confirmedPageUrl: string | null
  reviewStatus: ReviewStatus
  reviewedAt: string | null
  keywords: { id: number; query: string; frequency: number | null }[]
}

type PageOption = {
  id: number
  url: string
  locale: string | null
  title: string | null
  h1: string | null
  description: string | null
}

function pagePath(url: string) {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

// Mirrors the prefix detection in lib/html-extract.ts, which is what populates pages.locale
// during sync — kept in sync so a URL prefix and the stored locale never disagree here.
const LOCALE_PREFIXES = new Set(['ru', 'en', 'kk', 'kz'])

function urlLocale(url: string): string | null {
  const prefix = pagePath(url).match(/^\/([a-z]{2})(\/|$)/i)?.[1]?.toLowerCase()
  return prefix && LOCALE_PREFIXES.has(prefix) ? prefix : null
}

/** A page's language: its URL prefix (/ru/…) takes priority, falling back to the stored locale column. */
function pageLocale(p: PageOption): string | null {
  return urlLocale(p.url) ?? (p.locale ? p.locale.toLowerCase() : null)
}

/**
 * A cluster's language, used to filter page search results so an RU cluster only offers RU
 * pages (and vice versa). Prefers the AI-recommended page's language — the most reliable
 * signal — and only falls back to guessing from the primary keyword's script when no
 * recommendation exists. Never derived from confirmedPageId: a previously mis-confirmed page
 * must not bias the language filter.
 */
function clusterLocale(c: ClusterRow, pages: PageOption[]): string | null {
  if (c.recommendedPageId != null) {
    const recommended = pages.find((p) => p.id === c.recommendedPageId)
    const loc = recommended ? pageLocale(recommended) : c.recommendedPageUrl ? urlLocale(c.recommendedPageUrl) : null
    if (loc) return loc
  }
  if (c.primaryKeyword) return /[Ѐ-ӿ]/.test(c.primaryKeyword) ? 'ru' : 'en'
  return null
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
function searchPages(pages: PageOption[], query: string): PageOption[] {
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
function getRecommendedPages(c: ClusterRow, pages: PageOption[]): PageOption[] {
  const result: PageOption[] = []
  const seen = new Set<number>()

  const aiPick = c.recommendedPageId != null ? pages.find((p) => p.id === c.recommendedPageId) : undefined
  if (aiPick) {
    result.push(aiPick)
    seen.add(aiPick.id)
  }

  const clusterLoc = clusterLocale(c, pages)
  const localePages = clusterLoc ? pages.filter((p) => pageLocale(p) === clusterLoc) : pages
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

function PageSearch({
  pages,
  onSelect,
  onClose,
}: {
  pages: PageOption[]
  onSelect: (p: PageOption) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const results = searchPages(pages, query)
  return (
    <div className="relative w-full min-w-[220px]" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.seoClusters.searchPlaceholder}
          className="w-full border border-hairline bg-card px-3 py-2 text-xs text-foreground outline-none focus:border-blue"
        />
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {results.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-64 w-[560px] max-w-[calc(100vw-2rem)] overflow-y-auto border border-hairline bg-card shadow-sm">
          {results.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p)}
              className="block w-full px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60"
            >
              <span className="block whitespace-normal break-words font-mono text-blue">{pagePath(p.url)}</span>
              {(p.title || p.h1) && (
                <span className="mt-0.5 block whitespace-normal break-words text-muted-foreground">
                  {p.title || p.h1}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const REVIEW_STATUS_DOT: Record<ReviewStatus, string> = {
  pending: 'bg-muted-foreground',
  confirmed: 'bg-blue',
  no_page: 'bg-destructive',
  ignored: 'bg-muted-foreground',
}

function ReviewStatusPill({ status }: { status: ReviewStatus }) {
  const { t } = useI18n()
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className={`size-1.5 rounded-full ${REVIEW_STATUS_DOT[status]}`} aria-hidden />
      <span className="label-mono text-foreground/80">{t.seoClusters.reviewStatusLabel[status]}</span>
    </span>
  )
}

function canConfirmPage(c: ClusterRow, pageId: number) {
  return c.reviewStatus !== 'confirmed' || c.confirmedPageId !== pageId
}

function ConfirmRecommendedButton({
  saving,
  onConfirm,
}: {
  saving: boolean
  onConfirm: () => void
}) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onConfirm()
      }}
      disabled={saving}
      className="label-mono shrink-0 whitespace-nowrap border-b border-blue text-blue transition-colors hover:border-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {t.seoClusters.confirmRecommended}
    </button>
  )
}

function ClusterTaskButton({
  kind,
  onOpen,
  saving,
}: {
  kind: 'improve' | 'create'
  onOpen: () => void
  saving?: boolean
}) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      disabled={saving}
      className="label-mono shrink-0 whitespace-nowrap border-b border-foreground/50 text-foreground/80 transition-colors hover:border-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {kind === 'improve' ? t.seoClusters.improvePage : t.seoClusters.createPage}
    </button>
  )
}

/**
 * "Recommended pages" block: up to 3 candidates (AI pick first), each with its own compact
 * Confirm button, plus a Find existing link — used in both the table row and the expanded detail
 * view so the two stay in sync.
 */
function RecommendedPagesList({
  cluster,
  pages,
  saving,
  onConfirm,
  onFindExisting,
}: {
  cluster: ClusterRow
  pages: PageOption[]
  saving: boolean
  onConfirm: (page: PageOption) => void
  onFindExisting: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-1.5">
      {pages.length > 0 ? (
        pages.map((p) => (
          <div key={p.id} className="flex items-center gap-2 overflow-hidden">
            <span className="truncate font-mono text-xs text-blue">{pagePath(p.url)}</span>
            {canConfirmPage(cluster, p.id) && (
              <ConfirmRecommendedButton saving={saving} onConfirm={() => onConfirm(p)} />
            )}
          </div>
        ))
      ) : (
        <span className="text-muted-foreground">{t.seoClusters.noPage}</span>
      )}
      <FindPageButton label={t.seoClusters.findExisting} onClick={onFindExisting} />
    </div>
  )
}

function FindPageButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="label-mono shrink-0 whitespace-nowrap border-b border-foreground/50 text-foreground/80 transition-colors hover:border-foreground hover:text-foreground"
    >
      {label}
    </button>
  )
}

function IgnoreButton({ saving, onIgnore }: { saving: boolean; onIgnore: () => void }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onIgnore()
      }}
      disabled={saving}
      className="label-mono shrink-0 whitespace-nowrap border-b border-foreground/30 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {t.seoClusters.ignoreAction}
    </button>
  )
}

type TaskPanelState = {
  title: string
  text: string
}

function TaskPanel({ panel, onClose }: { panel: TaskPanelState; onClose: () => void }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(panel.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-foreground/10" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 z-40 flex h-full w-full max-w-2xl flex-col border-l border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
          <span className="label-mono text-muted-foreground">{panel.title}</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-hidden px-6 py-6">
          <button
            type="button"
            onClick={handleCopy}
            className="label-mono w-fit shrink-0 border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground"
          >
            {copied ? t.seoClusters.taskCopied : t.seoClusters.copyTask}
          </button>
          <textarea
            readOnly
            value={panel.text}
            className="flex-1 resize-none overflow-y-auto border border-hairline bg-background p-4 font-mono text-xs leading-relaxed text-foreground/90 outline-none"
          />
        </div>
      </aside>
    </>
  )
}

export function SeoClusters() {
  const { t, locale } = useI18n()
  const numberLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const { projects } = useProjects()
  const [projectId, setProjectId] = useState<number | null>(null)
  const [clusters, setClusters] = useState<ClusterRow[]>([])
  const [pages, setPages] = useState<PageOption[]>([])
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [taskPanel, setTaskPanel] = useState<TaskPanelState | null>(null)
  const [searchOpenId, setSearchOpenId] = useState<number | null>(null)

  useEffect(() => {
    if (projects.length && projectId === null) setProjectId(projects[0].id)
  }, [projects, projectId])

  function loadClusters(id: number) {
    setLoading(true)
    fetch(`/api/seo-clusters?projectId=${id}`)
      .then((r) => r.json())
      .then(setClusters)
      .finally(() => setLoading(false))
  }

  function loadPages(id: number) {
    fetch(`/api/pages?projectId=${id}`)
      .then((r) => r.json())
      .then((rows: any[]) =>
        setPages(
          rows
            .map((r) => ({
              id: r.id,
              url: r.url,
              locale: r.locale,
              title: r.title,
              h1: r.h1,
              description: r.description,
            }))
            .sort((a, b) => a.url.localeCompare(b.url)),
        ),
      )
  }

  useEffect(() => {
    if (projectId === null) return
    setExpanded(null)
    setSearchOpenId(null)
    loadClusters(projectId)
    loadPages(projectId)
  }, [projectId])

  async function handleReview(
    clusterId: number,
    reviewStatus: 'confirmed' | 'no_page' | 'ignored',
    pageId: number | null,
  ): Promise<boolean> {
    if (projectId === null) return false
    setSavingId(clusterId)
    setError(null)
    try {
      const res = await fetch('/api/seo-clusters', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterId, projectId, reviewStatus, pageId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t.seoClusters.updateError)
      setClusters(data)
      return true
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t.seoClusters.updateError)
      return false
    } finally {
      setSavingId(null)
    }
  }

  async function handleSelectPage(cluster: ClusterRow, page: PageOption) {
    const ok = await handleReview(cluster.id, 'confirmed', page.id)
    if (ok) setSearchOpenId(null)
  }

  /**
   * One click for an AI "no page" cluster: confirms review_status = no_page (the same PATCH the
   * old manual dropdown flow used), then opens the existing Create-page task panel — collapsing
   * "human confirms no_page" and "open Create task" into a single action.
   */
  async function handleCreatePageOneClick(cluster: ClusterRow) {
    const ok = await handleReview(cluster.id, 'no_page', null)
    if (ok) handleOpenTask(cluster, 'create')
  }

  function handleOpenTask(cluster: ClusterRow, kind: 'improve' | 'create') {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return

    const clusterInput = {
      name: cluster.name,
      primaryKeyword: cluster.primaryKeyword,
      intent: cluster.intent,
      totalFrequency: cluster.totalFrequency,
      keywords: cluster.keywords.map((k) => ({ query: k.query, frequency: k.frequency })),
    }
    const taskLocale: TaskLocale = clusterLocale(cluster, pages) === 'ru' ? 'ru' : 'en'

    if (kind === 'improve') {
      if (cluster.confirmedPageId == null) return
      const matched = pages.find((p) => p.id === cluster.confirmedPageId)
      const page: TaskPage = matched
        ? { url: matched.url, title: matched.title, h1: matched.h1, description: matched.description, locale: matched.locale }
        : { url: cluster.confirmedPageUrl ?? '', title: null, h1: null, description: null, locale: null }
      const text = buildImproveTask({ name: project.name, domain: project.domain }, clusterInput, page, taskLocale)
      setTaskPanel({ title: t.seoClusters.improvePage, text })
    } else {
      const text = buildCreateTask({ name: project.name, domain: project.domain }, clusterInput, taskLocale)
      setTaskPanel({ title: t.seoClusters.createPage, text })
    }
  }

  async function handleGenerate() {
    if (projectId === null) return
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/seo-clusters/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t.seoClusters.generateError)
      setClusters(data.clusters)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t.seoClusters.generateError)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="07"
        title={t.seoClusters.title}
        description={t.seoClusters.description}
        action={
          <div className="flex items-center gap-3">
            <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
            <button
              onClick={handleGenerate}
              disabled={generating || projectId === null}
              className="label-mono whitespace-nowrap border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {generating ? t.seoClusters.generating : t.seoClusters.generateButton}
            </button>
          </div>
        }
      />

      {error && <p className="label-mono text-destructive">{error}</p>}
      {!loading && !error && clusters.length === 0 && (
        <p className="label-mono text-muted-foreground">{t.seoClusters.empty}</p>
      )}

      {clusters.length > 0 && (
        <TableShell>
          <thead>
            <tr>
              <Th>{t.seoClusters.cluster}</Th>
              <Th>{t.seoClusters.primaryKeyword}</Th>
              <Th className="text-right">{t.seoClusters.keywordsCount}</Th>
              <Th className="text-right">{t.table.frequency}</Th>
              <Th>{t.seoClusters.intent}</Th>
              <Th>{t.seoClusters.recommendedPage}</Th>
              <Th className="text-right">{t.seoClusters.confidence}</Th>
              <Th>{t.table.status}</Th>
              <Th>{t.seoClusters.targetPage}</Th>
              <Th>{t.seoClusters.reviewStatus}</Th>
            </tr>
          </thead>
          <tbody>
            {clusters.map((c) => {
              const isOpen = expanded === c.id
              const clusterLoc = clusterLocale(c, pages)
              // Only pages matching the cluster's language are offered in search results — an RU
              // cluster must never surface EN pages and vice versa.
              const searchablePages = clusterLoc ? pages.filter((p) => pageLocale(p) === clusterLoc) : pages
              const recommendedPages = getRecommendedPages(c, pages)
              return (
                <Fragment key={c.id}>
                  <tr
                    onClick={() => setExpanded(isOpen ? null : c.id)}
                    className="cursor-pointer transition-colors hover:bg-muted/60"
                  >
                    <Td className="text-foreground">{c.name}</Td>
                    <Td className="text-foreground/80">{c.primaryKeyword ?? '—'}</Td>
                    <Td className="text-right font-mono">{c.keywords.length}</Td>
                    <Td className="text-right font-mono">
                      {(c.totalFrequency ?? 0).toLocaleString(numberLocale)}
                    </Td>
                    <Td>
                      <span className="label-mono text-muted-foreground">
                        {t.seoClusters.intentLabel[c.intent as keyof typeof t.seoClusters.intentLabel] ?? c.intent}
                      </span>
                    </Td>
                    <Td className="max-w-[240px]">
                      <RecommendedPagesList
                        cluster={c}
                        pages={recommendedPages}
                        saving={savingId === c.id}
                        onConfirm={(p) => handleSelectPage(c, p)}
                        onFindExisting={() => setSearchOpenId(c.id)}
                      />
                    </Td>
                    <Td className="text-right font-mono">{c.confidence ?? '—'}</Td>
                    <Td>
                      <StatusPill status={c.status} />
                    </Td>
                    <Td>
                      {searchOpenId === c.id ? (
                        <PageSearch
                          pages={searchablePages}
                          onSelect={(p) => handleSelectPage(c, p)}
                          onClose={() => setSearchOpenId(null)}
                        />
                      ) : c.reviewStatus === 'ignored' ? (
                        <span className="text-muted-foreground">—</span>
                      ) : c.reviewStatus === 'confirmed' ? (
                        c.confirmedPageUrl ? (
                          <span className="font-mono text-xs text-blue">{pagePath(c.confirmedPageUrl)}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-3">
                        <ReviewStatusPill status={c.reviewStatus} />
                        {c.reviewStatus === 'confirmed' && c.confirmedPageId != null && (
                          <ClusterTaskButton kind="improve" onOpen={() => handleOpenTask(c, 'improve')} />
                        )}
                        {c.reviewStatus === 'no_page' && (
                          <ClusterTaskButton kind="create" onOpen={() => handleOpenTask(c, 'create')} />
                        )}
                        {c.needsNewPage && c.reviewStatus === 'pending' && (
                          <ClusterTaskButton
                            kind="create"
                            saving={savingId === c.id}
                            onOpen={() => handleCreatePageOneClick(c)}
                          />
                        )}
                        {c.reviewStatus === 'pending' && (
                          <IgnoreButton
                            saving={savingId === c.id}
                            onIgnore={() => handleReview(c.id, 'ignored', null)}
                          />
                        )}
                      </div>
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-muted/40">
                      <td colSpan={10} className="border-b border-hairline px-4 py-3.5 align-top">
                        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 border-b border-hairline pb-4 sm:grid-cols-3">
                          <div>
                            <dt className="label-mono text-muted-foreground">{t.seoClusters.primaryKeyword}</dt>
                            <dd className="mt-1 text-foreground/90">{c.primaryKeyword ?? '—'}</dd>
                          </div>
                          <div>
                            <dt className="label-mono text-muted-foreground">{t.seoClusters.intent}</dt>
                            <dd className="mt-1 text-foreground/90">
                              {t.seoClusters.intentLabel[c.intent as keyof typeof t.seoClusters.intentLabel] ?? c.intent}
                            </dd>
                          </div>
                          <div>
                            <dt className="label-mono text-muted-foreground">{t.table.frequency}</dt>
                            <dd className="mt-1 font-mono text-foreground/90">
                              {(c.totalFrequency ?? 0).toLocaleString(numberLocale)}
                            </dd>
                          </div>
                          <div>
                            <dt className="label-mono text-muted-foreground">{t.seoClusters.recommendedPage}</dt>
                            <dd className="mt-1 text-foreground/90">
                              <RecommendedPagesList
                                cluster={c}
                                pages={recommendedPages}
                                saving={savingId === c.id}
                                onConfirm={(p) => handleSelectPage(c, p)}
                                onFindExisting={() => setSearchOpenId(c.id)}
                              />
                            </dd>
                          </div>
                          <div>
                            <dt className="label-mono text-muted-foreground">{t.seoClusters.confirmedTargetPage}</dt>
                            <dd className="mt-1 text-foreground/90">
                              {c.confirmedPageUrl ? (
                                <span className="font-mono text-xs text-blue">{pagePath(c.confirmedPageUrl)}</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt className="label-mono text-muted-foreground">{t.seoClusters.reviewStatus}</dt>
                            <dd className="mt-1">
                              <ReviewStatusPill status={c.reviewStatus} />
                            </dd>
                          </div>
                        </dl>
                        <span className="mt-4 block label-mono text-muted-foreground">{t.seoClusters.keywordsInCluster}</span>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {c.keywords.map((k) => (
                            <span
                              key={k.id}
                              className="inline-flex items-center gap-2 border border-hairline bg-card px-2.5 py-1 text-xs text-foreground/80"
                            >
                              {k.query}
                              <span className="font-mono text-muted-foreground">
                                {(k.frequency ?? 0).toLocaleString(numberLocale)}
                              </span>
                            </span>
                          ))}
                        </div>
                        {c.reason && (
                          <p className="mt-3 max-w-2xl text-xs text-muted-foreground">{c.reason}</p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </TableShell>
      )}

      {taskPanel && <TaskPanel panel={taskPanel} onClose={() => setTaskPanel(null)} />}
    </div>
  )
}
