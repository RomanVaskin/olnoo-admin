'use client'

import { useEffect, useState } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'
import { RelevanceSelect, type RelevanceFilter } from '@/components/sections/keywords-cleanup'
import type { RelevanceStatus } from '@/lib/keywords-relevance-rules'

type KeywordRow = {
  id: number
  query: string
  frequency: number | null
  region: string | null
  cluster: string | null
  target_page_url: string | null
  relevance_status: RelevanceStatus | null
  relevance_confidence: number | null
  relevance_reason: string | null
  relevance_manual: boolean
}

const RELEVANCE_FILTERS: RelevanceFilter[] = ['all', 'unclassified', 'target', 'informational', 'uncertain', 'geo_mismatch', 'irrelevant']

export function KeywordsView() {
  const { t, locale } = useI18n()
  const numberLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const { projects } = useProjects()
  const [projectId, setProjectId] = useState<number | null>(null)
  const [keywords, setKeywords] = useState<KeywordRow[]>([])
  const [loading, setLoading] = useState(false)
  const [relevanceFilter, setRelevanceFilter] = useState<RelevanceFilter>('all')

  async function handleRelevance(keywordId: number, status: RelevanceStatus | null) {
    if (projectId === null) return
    const res = await fetch('/api/keywords/relevance', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, keywordId, status }),
    })
    if (!res.ok) return
    setKeywords((prev) =>
      prev.map((k) =>
        k.id !== keywordId
          ? k
          : {
              ...k,
              relevance_status: status,
              relevance_manual: status !== null,
              relevance_confidence: null,
              relevance_reason: status === null ? null : 'Решение пользователя',
            },
      ),
    )
  }

  const visible = keywords.filter((k) =>
    relevanceFilter === 'all' ? true : relevanceFilter === 'unclassified' ? k.relevance_status === null : k.relevance_status === relevanceFilter,
  )

  useEffect(() => {
    if (projects.length && projectId === null) setProjectId(projects[0].id)
  }, [projects, projectId])

  useEffect(() => {
    if (projectId === null) return
    setLoading(true)
    fetch(`/api/keywords?projectId=${projectId}`)
      .then((res) => res.json())
      .then(setKeywords)
      .finally(() => setLoading(false))
  }, [projectId])

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="04"
        title={t.keywordsView.title}
        description={t.keywordsView.description}
        action={<ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />}
      />

      {!loading && keywords.length === 0 && (
        <p className="label-mono text-muted-foreground">{t.keywordsView.empty}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {RELEVANCE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setRelevanceFilter(f)}
            className={`label-mono border px-3 py-1.5 transition-colors ${
              relevanceFilter === f ? 'border-foreground bg-foreground text-background' : 'border-hairline text-muted-foreground hover:text-foreground'
            }`}
          >
            {f === 'all' ? t.relevance.filterAll : t.relevance.status[f]}
          </button>
        ))}
      </div>

      <TableShell>
        <thead>
          <tr>
            <Th>{t.table.keyword}</Th>
            <Th className="text-right">{t.table.frequency}</Th>
            <Th>{t.table.region}</Th>
            <Th>{t.table.cluster}</Th>
            <Th>{t.table.targetPage}</Th>
            <Th>{t.table.status}</Th>
            <Th>{t.relevance.decision}</Th>
            <Th className="text-right">{t.relevance.confidence}</Th>
            <Th>{t.relevance.reason}</Th>
          </tr>
        </thead>
        <tbody>
          {visible.map((k) => {
            const status = k.target_page_url ? 'Mapped' : 'No page'
            return (
              <tr key={k.id} className="transition-colors hover:bg-muted/60">
                <Td className="text-foreground">{k.query}</Td>
                <Td className="text-right font-mono">
                  {(k.frequency ?? 0).toLocaleString(numberLocale)}
                </Td>
                <Td className="text-muted-foreground">{k.region ?? '—'}</Td>
                <Td>
                  <span className="label-mono text-foreground/70">{k.cluster ?? '—'}</span>
                </Td>
                <Td
                  className={
                    k.target_page_url
                      ? 'font-mono text-xs text-blue'
                      : 'font-mono text-xs text-muted-foreground'
                  }
                >
                  {k.target_page_url ?? '—'}
                </Td>
                <Td>
                  <StatusPill status={status} />
                </Td>
                <Td>
                  <RelevanceSelect status={k.relevance_status} manual={k.relevance_manual} onChange={(next) => void handleRelevance(k.id, next)} />
                </Td>
                <Td className="text-right font-mono text-xs text-muted-foreground">{k.relevance_confidence ?? '—'}</Td>
                <Td className="text-xs text-muted-foreground">{k.relevance_reason ?? '—'}</Td>
              </tr>
            )
          })}
        </tbody>
      </TableShell>
    </div>
  )
}
