'use client'

import { Fragment, useEffect, useState } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'

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

type PageOption = { id: number; url: string }

function pagePath(url: string) {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
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
      .then((rows: any[]) => setPages(rows.map((r) => ({ id: r.id, url: r.url })).sort((a, b) => a.url.localeCompare(b.url))))
  }

  useEffect(() => {
    if (projectId === null) return
    setExpanded(null)
    loadClusters(projectId)
    loadPages(projectId)
  }, [projectId])

  async function handleReview(clusterId: number, reviewStatus: 'confirmed' | 'no_page' | 'ignored', pageId: number | null) {
    if (projectId === null) return
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
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t.seoClusters.updateError)
    } finally {
      setSavingId(null)
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
                    <Td className="max-w-[220px] truncate">
                      {c.recommendedPageUrl ? (
                        <span className="font-mono text-xs text-blue">{pagePath(c.recommendedPageUrl)}</span>
                      ) : (
                        <span className="text-muted-foreground">{t.seoClusters.noPage}</span>
                      )}
                    </Td>
                    <Td className="text-right font-mono">{c.confidence ?? '—'}</Td>
                    <Td>
                      <StatusPill status={c.status} />
                    </Td>
                    <Td>
                      <div className="relative" onClick={(e) => e.stopPropagation()}>
                        <select
                          value={
                            c.reviewStatus === 'confirmed' && c.confirmedPageId
                              ? String(c.confirmedPageId)
                              : c.reviewStatus === 'no_page' || c.reviewStatus === 'ignored'
                                ? c.reviewStatus
                                : ''
                          }
                          disabled={savingId === c.id}
                          onChange={(e) => {
                            const val = e.target.value
                            if (!val) return
                            if (val === 'no_page') handleReview(c.id, 'no_page', null)
                            else if (val === 'ignored') handleReview(c.id, 'ignored', null)
                            else handleReview(c.id, 'confirmed', Number(val))
                          }}
                          className="w-full min-w-[180px] appearance-none border border-hairline bg-card px-3 py-2 pr-7 text-xs text-foreground outline-none focus:border-blue disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <option value="" disabled hidden>
                            {t.seoClusters.targetPagePlaceholder}
                          </option>
                          {pages.map((p) => (
                            <option key={p.id} value={p.id}>
                              {pagePath(p.url)}
                            </option>
                          ))}
                          <option value="no_page">{t.seoClusters.targetPageNoPage}</option>
                          <option value="ignored">{t.seoClusters.targetPageIgnored}</option>
                        </select>
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
                          ▾
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <ReviewStatusPill status={c.reviewStatus} />
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
                              {c.recommendedPageUrl ? (
                                <span className="font-mono text-xs text-blue">{pagePath(c.recommendedPageUrl)}</span>
                              ) : (
                                <span className="text-muted-foreground">{t.seoClusters.noPage}</span>
                              )}
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
    </div>
  )
}
