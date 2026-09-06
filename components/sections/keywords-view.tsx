'use client'

import { useEffect, useState } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'

type KeywordRow = {
  id: number
  query: string
  frequency: number | null
  region: string | null
  cluster: string | null
  target_page_url: string | null
}

export function KeywordsView() {
  const { t, locale } = useI18n()
  const numberLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const { projects } = useProjects()
  const [projectId, setProjectId] = useState<number | null>(null)
  const [keywords, setKeywords] = useState<KeywordRow[]>([])
  const [loading, setLoading] = useState(false)

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

      <TableShell>
        <thead>
          <tr>
            <Th>{t.table.keyword}</Th>
            <Th className="text-right">{t.table.frequency}</Th>
            <Th>{t.table.region}</Th>
            <Th>{t.table.cluster}</Th>
            <Th>{t.table.targetPage}</Th>
            <Th>{t.table.status}</Th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((k) => {
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
              </tr>
            )
          })}
        </tbody>
      </TableShell>
    </div>
  )
}
