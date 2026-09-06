'use client'

import { useEffect, useState } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'

type PageRow = {
  id: number
  url: string
  title: string | null
  h1: string | null
  locale: string | null
  target_keyword: string | null
  status: string
}

export function PagesView() {
  const { t } = useI18n()
  const { projects } = useProjects()
  const [projectId, setProjectId] = useState<number | null>(null)
  const [pages, setPages] = useState<PageRow[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)

  useEffect(() => {
    if (projects.length && projectId === null) setProjectId(projects[0].id)
  }, [projects, projectId])

  useEffect(() => {
    if (projectId === null) return
    setLoading(true)
    fetch(`/api/pages?projectId=${projectId}`)
      .then((res) => res.json())
      .then(setPages)
      .finally(() => setLoading(false))
  }, [projectId])

  async function handleSync() {
    if (projectId === null) return
    setSyncing(true)
    setSyncMessage(null)
    try {
      const res = await fetch('/api/pages/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Sync failed')
      setSyncMessage(t.pagesView.syncResult(data.found, data.upserted, data.failed))
      const refreshed = await fetch(`/api/pages?projectId=${projectId}`).then((r) => r.json())
      setPages(refreshed)
    } catch {
      setSyncMessage(t.pagesView.syncError)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="03"
        title={t.pagesView.title}
        description={t.pagesView.description}
        action={
          <div className="flex items-center gap-3">
            <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
            <button
              onClick={handleSync}
              disabled={syncing || projectId === null}
              className="label-mono whitespace-nowrap border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {syncing ? t.pagesView.syncing : t.pagesView.syncButton}
            </button>
          </div>
        }
      />

      {syncMessage && <p className="label-mono text-muted-foreground">{syncMessage}</p>}
      {!loading && !syncMessage && pages.length === 0 && (
        <p className="label-mono text-muted-foreground">{t.pagesView.empty}</p>
      )}

      <TableShell>
        <thead>
          <tr>
            <Th>{t.table.url}</Th>
            <Th>{t.table.title}</Th>
            <Th>{t.table.h1}</Th>
            <Th>{t.table.locale}</Th>
            <Th>{t.table.targetKeyword}</Th>
            <Th>{t.table.status}</Th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.id} className="transition-colors hover:bg-muted/60">
              <Td className="font-mono text-xs text-blue">{p.url}</Td>
              <Td className="max-w-[220px] truncate">{p.title ?? '—'}</Td>
              <Td className="max-w-[180px] truncate text-foreground/80">{p.h1 ?? '—'}</Td>
              <Td>
                <span className="label-mono text-muted-foreground">{p.locale ?? '—'}</span>
              </Td>
              <Td className="text-foreground/80">{p.target_keyword ?? '—'}</Td>
              <Td>
                <StatusPill status={p.status} />
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  )
}
