'use client'

import { useEffect, useState } from 'react'
import { SectionHeader, HeaderActions, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'

// Only currently offered source types; existing website/youtube sources remain visible.
// Keep this local to avoid pulling server-only source registry into the client bundle.
const SOURCE_TYPES = ['telegram', 'rss'] as const
type SourceType = 'telegram' | 'rss' | 'website' | 'youtube'

type Source = {
  id: string
  type: SourceType
  handle: string
  enabled: boolean
  processingMode: 'ai' | 'copy'
  copyPermissionConfirmed: boolean
  lastCheckedAt: string | null
  lastError: string
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

export function ContentFactorySourcesView({
  project,
  onProjectChange,
}: {
  project: string
  onProjectChange: (id: string) => void
}) {
  const { t } = useI18n()
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [newType, setNewType] = useState<SourceType>('telegram')
  const [newHandle, setNewHandle] = useState('')
  const [newMode, setNewMode] = useState<'ai' | 'copy'>('ai')
  const [newCopyPermission, setNewCopyPermission] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [checkMessage, setCheckMessage] = useState<Record<string, string>>({})

  async function load() {
    if (project === 'all') {
      setSources([])
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`/api/content-factory/sources?project=${encodeURIComponent(project)}`)
      if (res.ok) setSources(await res.json())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    setCheckMessage({})
  }, [project])

  async function addSource() {
    if (!newHandle.trim()) return
    setCreating(true)
    setCreateError('')
    try {
      const res = await fetch(`/api/content-factory/sources?project=${encodeURIComponent(project)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: newType, handle: newHandle, processingMode: newMode, copyPermissionConfirmed: newCopyPermission }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error((data && data.error) || t.contentFactory.sources.createError)
      setNewHandle('')
      setNewMode('ai')
      setNewCopyPermission(false)
      await load()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t.contentFactory.sources.createError)
    } finally {
      setCreating(false)
    }
  }

  async function toggleEnabled(source: Source) {
    const res = await fetch(`/api/content-factory/sources/${source.id}?project=${encodeURIComponent(project)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !source.enabled }),
    })
    if (res.ok) await load()
  }

  async function changeMode(source: Source, mode: 'ai' | 'copy') {
    if (mode === 'copy' && !window.confirm(t.contentFactory.sources.confirmCopyPermission)) return
    const res = await fetch(`/api/content-factory/sources/${source.id}?project=${encodeURIComponent(project)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ processingMode: mode, copyPermissionConfirmed: mode === 'copy' }),
    })
    if (res.ok) await load()
  }

  async function remove(source: Source) {
    if (!window.confirm(t.contentFactory.sources.confirmDelete)) return
    const res = await fetch(`/api/content-factory/sources/${source.id}?project=${encodeURIComponent(project)}`, { method: 'DELETE' })
    if (res.ok) await load()
  }

  async function checkNow(source: Source) {
    setCheckingId(source.id)
    try {
      const res = await fetch(`/api/content-factory/sources/${source.id}/check?project=${encodeURIComponent(project)}`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (res.ok) {
        const message = data?.error
          ? data.error
          : t.contentFactory.sources.checkResult.replace('{count}', String(data?.createdCount ?? 0))
        setCheckMessage((m) => ({ ...m, [source.id]: message }))
      }
      await load()
    } finally {
      setCheckingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="02"
        title={t.contentFactory.sources.title}
        description={t.contentFactory.sources.description}
        action={<ProjectSelector value={project} onChange={onProjectChange} />}
      />

      {project === 'all' ? (
        <p className="text-sm text-muted-foreground">{t.contentFactory.selectProjectHint}</p>
      ) : (
        <>
          <HeaderActions>
            <select
              value={newType}
              onChange={(e) => { setNewType(e.target.value as SourceType); setNewMode('ai'); setNewCopyPermission(false) }}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            >
              {SOURCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t.contentFactory.sourceType[type]}
                </option>
              ))}
            </select>
            <input
              value={newHandle}
              onChange={(e) => setNewHandle(e.target.value)}
              placeholder={newType === 'rss' ? 'https://example.com/news/feed.xml' : t.contentFactory.sources.handlePlaceholder}
              className="min-w-[220px] border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
            <select value={newMode} onChange={(e) => { setNewMode(e.target.value as 'ai' | 'copy'); setNewCopyPermission(false) }} className="border border-hairline bg-card px-3 py-2.5 text-sm">
              <option value="ai">{t.contentFactory.sources.modeAi}</option>
              <option value="copy" disabled={newType !== 'telegram'}>{t.contentFactory.sources.modeCopy}</option>
            </select>
            {newMode === 'copy' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={newCopyPermission} onChange={(e) => setNewCopyPermission(e.target.checked)} />{t.contentFactory.sources.copyPermission}</label>}
            <button
              onClick={addSource}
              disabled={creating || !newHandle.trim() || (newMode === 'copy' && !newCopyPermission)}
              className="label-mono flex items-center justify-center border border-foreground bg-foreground px-4 py-2 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
            >
              {t.contentFactory.sources.addSource}
            </button>
          </HeaderActions>
          {createError && <p className="text-sm text-destructive">{createError}</p>}

          <TableShell>
            <thead>
              <tr>
                <Th>{t.contentFactory.sources.tableSource}</Th>
                <Th>{t.contentFactory.sources.tableType}</Th>
                <Th>{t.contentFactory.sources.tableStatus}</Th>
                <Th>{t.contentFactory.sources.tableLastChecked}</Th>
                <Th>{t.table.actions}</Th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <Td className="font-medium text-foreground">{source.handle}</Td>
                  <Td>
                    <span className="label-mono text-muted-foreground">{t.contentFactory.sourceType[source.type]}</span>
                    <select value={source.processingMode} onChange={(e) => changeMode(source, e.target.value as 'ai' | 'copy')} className="mt-1 block border border-hairline bg-card p-1 text-xs">
                      <option value="ai">{t.contentFactory.sources.modeAi}</option>
                      <option value="copy" disabled={source.type !== 'telegram'}>{t.contentFactory.sources.modeCopy}</option>
                    </select>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <StatusPill status={source.enabled ? 'active' : 'paused'} />
                      {source.lastError && (
                        <span className="text-xs text-destructive">
                          {t.contentFactory.sources.lastErrorPrefix}
                          {source.lastError}
                        </span>
                      )}
                      {checkMessage[source.id] && <span className="text-xs text-muted-foreground">{checkMessage[source.id]}</span>}
                    </div>
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(source.lastCheckedAt)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => checkNow(source)}
                        disabled={checkingId === source.id}
                        className="label-mono border border-hairline px-2.5 py-1.5 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                      >
                        {checkingId === source.id ? t.contentFactory.sources.checking : t.contentFactory.sources.actionCheckNow}
                      </button>
                      <button
                        onClick={() => toggleEnabled(source)}
                        className="label-mono border border-hairline px-2.5 py-1.5 text-foreground transition-colors hover:bg-muted/60"
                      >
                        {source.enabled ? t.contentFactory.sources.actionDisable : t.contentFactory.sources.actionEnable}
                      </button>
                      <button
                        onClick={() => remove(source)}
                        className="label-mono border border-hairline px-2.5 py-1.5 text-destructive transition-colors hover:bg-muted/60"
                      >
                        {t.contentFactory.sources.actionDelete}
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
              {!loading && sources.length === 0 && (
                <tr>
                  <Td className="text-muted-foreground">
                    <span className="label-mono">{t.contentFactory.sources.noResults}</span>
                  </Td>
                  <Td> </Td>
                  <Td> </Td>
                  <Td> </Td>
                  <Td> </Td>
                </tr>
              )}
            </tbody>
          </TableShell>
        </>
      )}
    </div>
  )
}
