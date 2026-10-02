'use client'

import { Fragment, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker, type SeoProject } from '@/components/sections/seo-project-picker'
import {
  formatMegabytes,
  importSelectionError,
  isSupportedImportFile,
  mergeImportRows,
  type KeywordRow,
} from '@/lib/wordstat-import-rules'

type FileState = { status: 'pending' | 'done' | 'error'; total: number; error?: string; rows: KeywordRow[] }
type HistoryFile = { fileName: string; rowsCount: number; status: string }
type HistoryGroup = {
  key: string
  batchId: number | null
  legacy: boolean
  kind: string
  projectId: number
  projectName: string
  status: string
  createdAt: string
  filesCount: number
  rowsCount: number
  keywordsCount: number
  files: HistoryFile[]
}
const PREVIEW_ROWS = 20
const PARSE_CONCURRENCY = 4
const HISTORY_PAGE = 10
const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`
const totalBytes = (files: File[]) => files.reduce((sum, f) => sum + f.size, 0)

function hasDraggedFiles(e: { dataTransfer: DataTransfer | null }) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/** JSON body of an API answer, or a readable error when a proxy (e.g. nginx 413) answered with HTML. */
async function readJson(res: Response, rejected: (status: number) => string): Promise<Record<string, unknown>> {
  const data = await res.json().catch(() => null)
  if (data && typeof data === 'object') return data as Record<string, unknown>
  throw new Error(rejected(res.status))
}

export function WordstatImport() {
  const { t, locale } = useI18n()
  const w = t.wordstatImport
  const numberLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const { projects } = useProjects()
  const [projectId, setProjectId] = useState<number | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [parsed, setParsed] = useState<Record<string, FileState>>({})
  const [dragActive, setDragActive] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryGroup[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [deleteFor, setDeleteFor] = useState<HistoryGroup | null>(null)
  // Parse requests outlive selection changes; a generation counter drops answers for a cleared selection.
  const generation = useRef(0)

  useEffect(() => {
    if (projects.length && projectId === null) setProjectId(projects[0].id)
  }, [projects, projectId])

  function loadHistory(offset = 0) {
    fetch(`/api/keywords/import?limit=${HISTORY_PAGE}&offset=${offset}`)
      .then((r) => r.json())
      .then((data: { groups: HistoryGroup[]; hasMore: boolean }) => {
        setHistory((prev) => (offset ? [...prev, ...data.groups] : data.groups))
        setHasMore(data.hasMore)
      })
  }

  useEffect(() => {
    loadHistory()
  }, [])

  // A file dropped just outside the dropzone must not make the browser navigate away to it.
  useEffect(() => {
    const block = (e: globalThis.DragEvent) => {
      if (hasDraggedFiles(e)) e.preventDefault()
    }
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  function resetSelection() {
    generation.current += 1
    setFiles([])
    setParsed({})
    setMessage(null)
  }

  /** Each file is read by its own small request, so adding files never waits for or discards another batch. */
  async function parseFiles(list: File[]) {
    const gen = generation.current
    const queue = [...list]
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const key = fileKey(f)
        let state: FileState
        if (!isSupportedImportFile(f.name)) {
          state = { status: 'error', total: 0, error: 'Поддерживаются только файлы .csv и .xlsx', rows: [] }
        } else {
          try {
            const form = new FormData()
            form.set('projectId', String(projectId))
            form.set('confirm', 'false')
            form.append('file', f)
            const res = await fetch('/api/keywords/import', { method: 'POST', body: form })
            const data = await readJson(res, (status) => w.serverRejected(status, formatMegabytes(f.size)))
            const result = (data.files as { total: number; error?: string; rows?: KeywordRow[] }[] | undefined)?.[0]
            state = result
              ? { status: result.error ? 'error' : 'done', total: result.total, error: result.error, rows: result.rows ?? [] }
              : { status: 'error', total: 0, error: String(data.error ?? w.parseError), rows: [] }
          } catch (err) {
            state = { status: 'error', total: 0, error: err instanceof Error ? err.message : w.parseError, rows: [] }
          }
        }
        if (gen === generation.current) setParsed((prev) => ({ ...prev, [key]: state }))
      }
    }
    await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, worker))
  }

  function addFiles(list: FileList | null) {
    const incoming = Array.from(list ?? [])
    if (!incoming.length || projectId === null) return
    setMessage(null)
    const known = new Set(files.map(fileKey))
    const fresh = incoming.filter((f) => !known.has(fileKey(f)))
    setFiles((prev) => [...prev, ...fresh.filter((f) => !prev.some((p) => fileKey(p) === fileKey(f)))])
    setParsed((prev) => ({ ...prev, ...Object.fromEntries(fresh.map((f) => [fileKey(f), { status: 'pending', total: 0, rows: [] } as FileState])) }))
    void parseFiles(fresh)
  }

  function removeFile(file: File) {
    setFiles((prev) => prev.filter((f) => f !== file))
    setParsed((prev) => {
      const next = { ...prev }
      delete next[fileKey(file)]
      return next
    })
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    addFiles(e.target.files)
    // Allow picking the same file again later (onChange does not fire for an unchanged value).
    e.target.value = ''
  }

  function handleDragOver(e: DragEvent<HTMLLabelElement>) {
    if (!hasDraggedFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dragActive) setDragActive(true)
  }

  function handleDragLeave(e: DragEvent<HTMLLabelElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragActive(false)
  }

  function handleDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    setDragActive(false)
    addFiles(e.dataTransfer.files)
  }

  const states = files.map((f) => parsed[fileKey(f)])
  const pending = states.some((s) => !s || s.status === 'pending')
  const validFiles = files.filter((_, i) => states[i]?.status === 'done')
  const merged = mergeImportRows(validFiles.flatMap((f) => parsed[fileKey(f)].rows))
  const limitError = importSelectionError(validFiles.map((f) => ({ name: f.name, size: f.size })))

  async function handleImport() {
    if (!validFiles.length || projectId === null || pending || limitError) return
    setImporting(true)
    setMessage(null)
    try {
      const form = new FormData()
      form.set('projectId', String(projectId))
      form.set('confirm', 'true')
      for (const f of validFiles) form.append('file', f)
      const res = await fetch('/api/keywords/import', { method: 'POST', body: form })
      const data = await readJson(res, (status) => w.serverRejected(status, formatMegabytes(totalBytes(validFiles))))
      if (!res.ok) throw new Error(String(data.error ?? w.importError))
      resetSelection()
      setMessage(w.importDone(data as { imported: number; created: number; updated: number; files: number }))
      loadHistory()
    } catch (err) {
      setMessage(err instanceof Error && err.message ? err.message : w.importError)
    } finally {
      setImporting(false)
    }
  }

  const formatDate = (iso: string) => new Date(iso).toLocaleDateString(numberLocale)

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader index="06" title={w.title} description={w.description} />

      <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <label htmlFor="project" className="label-mono text-muted-foreground">
              {w.projectLabel}
            </label>
            <ProjectPicker
              projects={projects}
              value={projectId}
              onChange={(id) => {
                setProjectId(id)
                resetSelection()
              }}
            />
          </div>

          <label
            htmlFor="upload"
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`flex cursor-pointer flex-col items-center justify-center gap-3 border border-dashed bg-card px-6 py-12 text-center transition-colors hover:border-blue ${
              dragActive ? 'border-blue bg-blue/5' : 'border-border'
            }`}
          >
            <span className="font-mono text-2xl text-muted-foreground">↑</span>
            <span className="text-sm text-foreground">{dragActive ? w.dropzoneActive : w.dropzoneTitle}</span>
            <span className="label-mono text-muted-foreground">{w.dropzoneHint}</span>
            <input id="upload" type="file" accept=".csv,.xlsx" multiple className="sr-only" onChange={handleFileChange} />
          </label>

          {files.length > 0 && (
            <div className="flex flex-col gap-2">
              <ul className="flex max-h-80 flex-col overflow-y-auto border border-border">
                {files.map((f, i) => {
                  const state = states[i]
                  return (
                    <li key={fileKey(f)} className="flex items-start gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs">{f.name}</span>
                        {state?.error && <span className="block text-xs text-destructive">{state.error}</span>}
                      </span>
                      <span className="label-mono shrink-0 text-muted-foreground">
                        {state?.status === 'done' ? w.fileRows(state.total) : state?.status === 'error' ? '' : w.fileParsing}
                      </span>
                      <span className="label-mono shrink-0 text-muted-foreground">{formatMegabytes(f.size)}</span>
                      <button
                        type="button"
                        onClick={() => removeFile(f)}
                        disabled={importing}
                        aria-label={w.removeFile(f.name)}
                        className="label-mono shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        ×
                      </button>
                    </li>
                  )
                })}
              </ul>
              <div className="flex items-center justify-between gap-3">
                <span className="label-mono text-muted-foreground">
                  {w.selectionSummary(validFiles.length, formatMegabytes(totalBytes(validFiles)), merged.length)}
                </span>
                <button
                  type="button"
                  onClick={resetSelection}
                  disabled={importing}
                  className="label-mono text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {w.clearFiles}
                </button>
              </div>
              {limitError && <p className="text-xs text-destructive">{limitError}</p>}
            </div>
          )}

          <button
            onClick={handleImport}
            disabled={importing || pending || !validFiles.length || Boolean(limitError)}
            className="label-mono w-full border border-foreground bg-foreground px-4 py-3 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importing ? w.importing : w.importButton}
          </button>

          {message && <p className="label-mono text-muted-foreground">{message}</p>}
        </div>

        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">
            {merged.length ? w.preview(Math.min(PREVIEW_ROWS, merged.length), merged.length) : w.noPreview}
          </span>
          <TableShell>
            <thead>
              <tr>
                <Th>{t.table.keyword}</Th>
                <Th className="text-right">{t.table.frequency}</Th>
                <Th>{t.table.region}</Th>
              </tr>
            </thead>
            <tbody>
              {merged.slice(0, PREVIEW_ROWS).map((r, i) => (
                <tr key={i}>
                  <Td>{r.keyword}</Td>
                  <Td className="text-right font-mono">{r.frequency.toLocaleString(numberLocale)}</Td>
                  <Td className="text-muted-foreground">{r.region}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">{w.recentImports}</span>
        <TableShell>
          <thead>
            <tr>
              <Th>{t.table.date}</Th>
              <Th>{t.table.project}</Th>
              <Th className="text-right">{t.table.file}</Th>
              <Th className="text-right">{w.historyKeywordsHeader}</Th>
              <Th>{t.table.status}</Th>
              <Th>{null}</Th>
            </tr>
          </thead>
          <tbody>
            {history.map((g) => (
              <Fragment key={g.key}>
                <tr>
                  <Td className="font-mono text-xs text-muted-foreground">{formatDate(g.createdAt)}</Td>
                  <Td>
                    {g.projectName}
                    {g.legacy && <span className="label-mono ml-2 text-muted-foreground">{w.historyLegacy}</span>}
                  </Td>
                  <Td className="text-right font-mono text-xs">{w.historyFiles(g.filesCount)}</Td>
                  <Td className="text-right font-mono text-xs">{w.historyKeywords(g.keywordsCount)}</Td>
                  <Td>
                    <StatusPill status={g.status} />
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {g.files.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}
                        className="label-mono text-muted-foreground hover:text-foreground"
                      >
                        {expanded[g.key] ? w.hideFiles : w.showFiles}
                      </button>
                    )}
                    {g.kind === 'import' && g.status === 'Imported' && (
                      <button
                        type="button"
                        onClick={() => setDeleteFor(deleteFor?.key === g.key ? null : g)}
                        className="label-mono ml-4 text-destructive hover:text-foreground"
                      >
                        {w.deleteAction}
                      </button>
                    )}
                  </Td>
                </tr>
                {expanded[g.key] &&
                  g.files.map((f, i) => (
                    <tr key={`${g.key}-${i}`} className="bg-card">
                      <Td>{null}</Td>
                      <td colSpan={2} className="border-b border-hairline px-4 py-2 font-mono text-xs text-foreground/90">
                        {f.fileName}
                      </td>
                      <Td className="text-right font-mono text-xs">{f.rowsCount}</Td>
                      <Td>
                        <StatusPill status={f.status} />
                      </Td>
                      <Td>{null}</Td>
                    </tr>
                  ))}
                {deleteFor?.key === g.key && (
                  <tr>
                    <td colSpan={6} className="border-b border-hairline bg-card px-4 py-3.5">
                      <DeletePanel
                        group={g}
                        onClose={() => setDeleteFor(null)}
                        onDone={() => {
                          setDeleteFor(null)
                          loadHistory()
                        }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </TableShell>
        {hasMore && (
          <button
            type="button"
            onClick={() => loadHistory(history.length)}
            className="label-mono self-start text-muted-foreground hover:text-foreground"
          >
            {w.showMore}
          </button>
        )}
      </div>
    </div>
  )
}


type DeletePreview = {
  projectName: string
  createdAt: string
  files: number
  keywords: number
  toDelete: number
  existedBefore: number
  linked: { query: string; region: string }[]
  notFound: number | null
}

/** «Удалить импорт»: preview is mandatory; the delete button appears only after it loaded. */
function DeletePanel({ group, onClose, onDone }: { group: HistoryGroup; onClose: () => void; onDone: () => void }) {
  const { t, locale } = useI18n()
  const w = t.wordstatImport
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const [preview, setPreview] = useState<DeletePreview | null>(null)
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState<string | null>(null)

  async function call(confirm: boolean) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/keywords/import/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: group.key, confirm }),
      })
      const data = await readJson(res, (status) => w.serverRejected(status, ''))
      if (!res.ok) throw new Error(String(data.error ?? w.importError))
      if (confirm) {
        setMessage(w.deleteDone(Number(data.deleted)))
        onDone()
      } else {
        setPreview(data as unknown as DeletePreview)
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : w.importError)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void call(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.key])

  const created = new Date(group.createdAt)
  const rows: [string, string | number][] = preview
    ? [
        [w.deleteProject, preview.projectName],
        [w.deleteDate, `${created.toLocaleDateString(dateLocale)} ${created.toLocaleTimeString(dateLocale)}`],
        [w.deleteFiles, preview.files],
        [w.deleteKeywords, preview.keywords],
        [w.deleteWill, preview.toDelete],
        [w.deleteExisted, preview.existedBefore],
        [w.deleteLinked, preview.linked.length],
        [w.deleteNotFound, preview.notFound ?? '—'],
      ]
    : []

  return (
    <div className="flex flex-col gap-4 py-2">
      <span className="text-sm font-medium">{w.deleteTitle}</span>
      {preview && (
        <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-8 gap-y-1 text-sm">
          {rows.map(([label, value], i) => (
            <Fragment key={label}>
              <dt className={`text-muted-foreground ${i === 4 ? 'mt-3' : ''}`}>{label}</dt>
              <dd className={`text-right font-mono ${i === 4 ? 'mt-3 text-foreground' : ''}`}>{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {preview && <p className="max-w-2xl text-xs text-muted-foreground">{w.deleteExplain}</p>}
      {preview && preview.linked.length > 0 && (
        <ul className="max-h-48 max-w-2xl overflow-y-auto border border-border text-xs">
          {preview.linked.map((c) => (
            <li key={`${c.query}\u0000${c.region}`} className="border-b border-border px-3 py-1.5 last:border-b-0">
              <span className="font-mono">{c.query}</span>
              {c.region && <span className="text-muted-foreground"> · {c.region}</span>}
              <span className="text-muted-foreground"> — {w.conflictLinked}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onClose} className="label-mono border border-foreground px-4 py-2 hover:bg-foreground hover:text-background">
          {w.deleteCancel}
        </button>
        {preview && (
          <button
            type="button"
            onClick={() => void call(true)}
            disabled={busy}
            className="label-mono border border-destructive bg-destructive px-4 py-2 text-background hover:bg-transparent hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          >
            {w.deleteConfirm}
          </button>
        )}
      </div>
      {message && <p className="label-mono text-muted-foreground">{message}</p>}
    </div>
  )
}
