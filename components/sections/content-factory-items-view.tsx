'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'

// Mirrors lib/content-factory-items.ts's ITEM_STATUSES and status-transition guards — kept as
// local literals/functions (not imported) for the same client-bundle-hygiene reason
// social-view.tsx's EDITOR_ACTIONS already is: this client component must never pull in a
// server-only module just for a type or a pure boolean check.
const ITEM_STATUSES = ['new', 'processing', 'ready', 'scheduled', 'published', 'needs_review', 'rejected', 'failed'] as const
type ItemStatus = (typeof ITEM_STATUSES)[number]

function canGenerate(status: ItemStatus): boolean {
  return status === 'new' || status === 'ready' || status === 'needs_review' || status === 'rejected' || status === 'failed'
}
function canApprove(status: ItemStatus): boolean {
  return status === 'needs_review'
}
function canPublish(status: ItemStatus): boolean {
  return status === 'ready'
}
function canReject(status: ItemStatus): boolean {
  return status === 'new' || status === 'ready' || status === 'needs_review' || status === 'failed'
}

type Item = {
  id: string
  sourceId: string
  externalId: string
  originalUrl: string
  originalText: string
  originalPublishedAt: string | null
  status: ItemStatus
  generatedTitle: string
  generatedText: string
  reviewReason: string
  error: string
  socialPostId: string | null
  createdAt: string
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function ItemDetail({
  item,
  project,
  onClose,
  onUpdated,
}: {
  item: Item
  project: string
  onClose: () => void
  onUpdated: (item: Item) => void
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState(item.generatedTitle)
  const [text, setText] = useState(item.generatedText)
  const [busy, setBusy] = useState<'generate' | 'publish' | 'save' | 'approve' | 'reject' | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setTitle(item.generatedTitle)
    setText(item.generatedText)
    setError('')
  }, [item])

  async function call(path: string, init: RequestInit, busyKind: typeof busy) {
    setBusy(busyKind)
    setError('')
    try {
      const res = await fetch(`${path}?project=${encodeURIComponent(project)}`, init)
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error((data && data.error) || 'Request failed.')
      onUpdated(data as Item)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.')
    } finally {
      setBusy(null)
    }
  }

  function generate() {
    call(`/api/content-factory/items/${item.id}/generate`, { method: 'POST' }, 'generate')
  }
  function saveEdit() {
    call(`/api/content-factory/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, text }) }, 'save')
  }
  function approve() {
    call(`/api/content-factory/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) }, 'approve')
  }
  function reject() {
    if (!window.confirm(t.contentFactory.items.confirmReject)) return
    call(`/api/content-factory/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reject' }) }, 'reject')
  }
  function publish() {
    call(`/api/content-factory/items/${item.id}/publish`, { method: 'POST' }, 'publish')
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-foreground/10" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 z-40 flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
          <StatusPill status={item.status} />
          <button onClick={onClose} className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground">
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-6 px-6 py-6">
          <div className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.contentFactory.items.original}</span>
            <p className="whitespace-pre-line border border-hairline bg-background p-3 text-sm text-muted-foreground">{item.originalText || '—'}</p>
            {item.originalUrl && (
              <a href={item.originalUrl} target="_blank" rel="noreferrer" className="label-mono text-blue underline underline-offset-4">
                {t.contentFactory.items.sourceLink}
              </a>
            )}
          </div>

          {item.reviewReason && (
            <p className="border border-hairline bg-background p-3 text-sm text-foreground">
              <span className="label-mono text-muted-foreground">{t.contentFactory.items.reviewReasonLabel} </span>
              {item.reviewReason}
            </p>
          )}
          {item.error && (
            <p className="text-sm text-destructive">
              <span className="label-mono">{t.contentFactory.items.errorLabel} </span>
              {item.error}
            </p>
          )}

          <div className="flex flex-col gap-3 border border-hairline bg-card p-4">
            <span className="label-mono text-muted-foreground">{t.contentFactory.items.prepared}</span>
            {item.generatedText || canGenerate(item.status) ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="label-mono text-muted-foreground">{t.contentFactory.items.editTitleLabel}</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="label-mono text-muted-foreground">{t.contentFactory.items.editTextLabel}</span>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={10}
                    className="resize-none border border-hairline bg-card p-3 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                  />
                </label>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t.contentFactory.items.noText}</p>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex flex-wrap gap-2">
              {canGenerate(item.status) && (
                <button
                  onClick={generate}
                  disabled={busy !== null}
                  className="label-mono border border-hairline px-3 py-2 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                >
                  {busy === 'generate' ? t.contentFactory.items.generating : item.generatedText ? t.contentFactory.items.actionRegenerate : t.contentFactory.items.actionGenerate}
                </button>
              )}
              {item.generatedText && (
                <button
                  onClick={saveEdit}
                  disabled={busy !== null}
                  className="label-mono border border-hairline px-3 py-2 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                >
                  {t.contentFactory.items.saveEdit}
                </button>
              )}
              {canApprove(item.status) && (
                <button
                  onClick={approve}
                  disabled={busy !== null}
                  className="label-mono border border-foreground bg-foreground px-3 py-2 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
                >
                  {t.contentFactory.items.actionApprove}
                </button>
              )}
              {canPublish(item.status) && (
                <button
                  onClick={publish}
                  disabled={busy !== null}
                  className="label-mono border border-foreground bg-foreground px-3 py-2 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
                >
                  {busy === 'publish' ? t.contentFactory.items.publishing : t.contentFactory.items.actionPublish}
                </button>
              )}
              {canReject(item.status) && (
                <button
                  onClick={reject}
                  disabled={busy !== null}
                  className="label-mono text-foreground/80 underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                >
                  {t.contentFactory.items.actionReject}
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}

export function ContentFactoryItemsView({
  project,
  onProjectChange,
}: {
  project: string
  onProjectChange: (id: string) => void
}) {
  const { t } = useI18n()
  const [items, setItems] = useState<Item[]>([])
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [selected, setSelected] = useState<Item | null>(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    if (project === 'all') {
      setItems([])
      return
    }
    setLoading(true)
    try {
      const qs = new URLSearchParams({ project })
      if (statusFilter) qs.set('status', statusFilter)
      const res = await fetch(`/api/content-factory/items?${qs.toString()}`)
      if (res.ok) setItems(await res.json())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    setSelected(null)
  }, [project, statusFilter])

  function handleUpdated(updated: Item) {
    setItems((current) => current.map((it) => (it.id === updated.id ? updated : it)))
    setSelected(updated)
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="03"
        title={t.contentFactory.items.title}
        description={t.contentFactory.items.description}
        action={<ProjectSelector value={project} onChange={onProjectChange} />}
      />

      {project === 'all' ? (
        <p className="text-sm text-muted-foreground">{t.contentFactory.selectProjectHint}</p>
      ) : (
        <>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-fit border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
          >
            <option value="">{t.contentFactory.items.filterAllStatuses}</option>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t.status[s]}
              </option>
            ))}
          </select>

          <TableShell>
            <thead>
              <tr>
                <Th>{t.field.status}</Th>
                <Th>{t.table.created}</Th>
                <Th>{t.contentFactory.items.original}</Th>
                <Th>{t.contentFactory.items.prepared}</Th>
                <Th>{t.table.actions}</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setSelected(item)}>
                  <Td>
                    <StatusPill status={item.status} />
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(item.createdAt)}</Td>
                  <Td className="max-w-[260px] truncate text-muted-foreground" title={item.originalText}>
                    {item.originalText || '—'}
                  </Td>
                  <Td className="max-w-[260px] truncate text-foreground" title={item.generatedTitle}>
                    {item.generatedTitle || '—'}
                  </Td>
                  <Td>
                    <button className="label-mono text-blue underline underline-offset-4">{t.common.open}</button>
                  </Td>
                </tr>
              ))}
              {!loading && items.length === 0 && (
                <tr>
                  <Td className="text-muted-foreground">
                    <span className="label-mono">{t.contentFactory.items.noResults}</span>
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

      {selected && <ItemDetail item={selected} project={project} onClose={() => setSelected(null)} onUpdated={handleUpdated} />}
    </div>
  )
}
