'use client'

import { Fragment, useEffect, useState } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'

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
  keywords: { id: number; query: string; frequency: number | null }[]
}

function pagePath(url: string) {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

export function SeoClusters() {
  const { t, locale } = useI18n()
  const numberLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const { projects } = useProjects()
  const [projectId, setProjectId] = useState<number | null>(null)
  const [clusters, setClusters] = useState<ClusterRow[]>([])
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
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

  useEffect(() => {
    if (projectId === null) return
    setExpanded(null)
    loadClusters(projectId)
  }, [projectId])

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
                  </tr>
                  {isOpen && (
                    <tr className="bg-muted/40">
                      <td colSpan={8} className="border-b border-hairline px-4 py-3.5 align-top">
                        <span className="label-mono text-muted-foreground">{t.seoClusters.keywordsInCluster}</span>
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
