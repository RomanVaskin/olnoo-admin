'use client'

import { useEffect, useState, type ChangeEvent, type DragEvent } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'

type PreviewRow = { keyword: string; frequency: number; region: string }
type FileResult = { fileName: string; total: number; error?: string }

const SUPPORTED_FILE = /\.(csv|xlsx)$/i
const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`

function hasDraggedFiles(e: { dataTransfer: DataTransfer | null }) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}
type ImportRecord = {
  id: number
  file_name: string
  project_name: string
  rows_count: number
  status: string
  created_at: string
}

export function WordstatImport() {
  const { t, locale } = useI18n()
  const numberLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const { projects } = useProjects()
  const [projectId, setProjectId] = useState<number | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [fileResults, setFileResults] = useState<FileResult[]>([])
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; total: number } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [imports, setImports] = useState<ImportRecord[]>([])

  useEffect(() => {
    if (projects.length && projectId === null) setProjectId(projects[0].id)
  }, [projects, projectId])

  function loadImports() {
    fetch('/api/keywords/import')
      .then((r) => r.json())
      .then(setImports)
  }

  useEffect(() => {
    loadImports()
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
    setFiles([])
    setFileResults([])
    setPreview(null)
    setMessage(null)
  }

  /** Re-parses the whole selection server-side: per-file row counts/errors + merged preview. */
  async function loadPreview(next: File[]) {
    setFiles(next)
    setFileResults([])
    setPreview(null)
    setMessage(null)
    if (!next.length || projectId === null) return

    setBusy(true)
    try {
      const form = new FormData()
      form.set('projectId', String(projectId))
      form.set('confirm', 'false')
      for (const f of next) form.append('file', f)
      const res = await fetch('/api/keywords/import', { method: 'POST', body: form })
      const data = await res.json()
      if (Array.isArray(data.files)) setFileResults(data.files)
      if (!res.ok && !Array.isArray(data.files)) throw new Error(data.error)
      if (res.ok) setPreview({ rows: data.preview, total: data.total })
    } catch (err) {
      setMessage(err instanceof Error && err.message ? err.message : t.wordstatImport.parseError)
    } finally {
      setBusy(false)
    }
  }

  function addFiles(list: FileList | null) {
    const incoming = Array.from(list ?? [])
    if (!incoming.length) return
    const known = new Set(files.map(fileKey))
    const next = [...files, ...incoming.filter((f) => !known.has(fileKey(f)))]
    void loadPreview(next)
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
    if (busy) return
    addFiles(e.dataTransfer.files)
  }

  // The API answers per file in upload order, so results match `files` by index (names can repeat).
  const validFiles = files.filter((f, i) => SUPPORTED_FILE.test(f.name) && fileResults[i] && !fileResults[i].error)

  async function handleImport() {
    if (!validFiles.length || projectId === null || !preview) return
    setBusy(true)
    setMessage(null)
    try {
      const form = new FormData()
      form.set('projectId', String(projectId))
      form.set('confirm', 'true')
      for (const f of validFiles) form.append('file', f)
      const res = await fetch('/api/keywords/import', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setFiles([])
      setFileResults([])
      setPreview(null)
      setMessage(t.wordstatImport.importSuccess(data.imported))
      loadImports()
    } catch (err) {
      setMessage(err instanceof Error && err.message ? err.message : t.wordstatImport.importError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="06"
        title={t.wordstatImport.title}
        description={t.wordstatImport.description}
      />

      <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <label htmlFor="project" className="label-mono text-muted-foreground">
              {t.wordstatImport.projectLabel}
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
            <span className="text-sm text-foreground">
              {dragActive ? t.wordstatImport.dropzoneActive : t.wordstatImport.dropzoneTitle}
            </span>
            <span className="label-mono text-muted-foreground">{t.wordstatImport.dropzoneHint}</span>
            <input
              id="upload"
              type="file"
              accept=".csv,.xlsx"
              multiple
              className="sr-only"
              onChange={handleFileChange}
            />
          </label>

          {files.length > 0 && (
            <div className="flex flex-col gap-2">
              <ul className="flex flex-col border border-border">
                {files.map((f, i) => {
                  const result = fileResults[i]
                  return (
                    <li key={fileKey(f)} className="flex items-start gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs">{f.name}</span>
                        {result?.error && <span className="block text-xs text-destructive">{result.error}</span>}
                      </span>
                      <span className="label-mono shrink-0 text-muted-foreground">
                        {result && !result.error ? t.wordstatImport.fileRows(result.total) : busy ? '…' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => void loadPreview(files.filter((x) => x !== f))}
                        disabled={busy}
                        aria-label={t.wordstatImport.removeFile(f.name)}
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
                  {preview ? t.wordstatImport.filesSummary(validFiles.length, preview.total) : ''}
                </span>
                <button
                  type="button"
                  onClick={resetSelection}
                  disabled={busy}
                  className="label-mono text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {t.wordstatImport.clearFiles}
                </button>
              </div>
            </div>
          )}

          <button
            onClick={handleImport}
            disabled={busy || !preview || !validFiles.length}
            className="label-mono w-full border border-foreground bg-foreground px-4 py-3 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? t.wordstatImport.importing : t.wordstatImport.importButton}
          </button>

          {message && <p className="label-mono text-muted-foreground">{message}</p>}
        </div>

        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">
            {preview
              ? t.wordstatImport.preview(preview.rows.length, preview.total)
              : t.wordstatImport.noPreview}
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
              {(preview?.rows ?? []).map((r, i) => (
                <tr key={i}>
                  <Td>{r.keyword}</Td>
                  <Td className="text-right font-mono">
                    {r.frequency.toLocaleString(numberLocale)}
                  </Td>
                  <Td className="text-muted-foreground">{r.region}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">{t.wordstatImport.recentImports}</span>
        <TableShell>
          <thead>
            <tr>
              <Th>{t.table.file}</Th>
              <Th>{t.table.project}</Th>
              <Th className="text-right">{t.table.rows}</Th>
              <Th>{t.table.date}</Th>
              <Th>{t.table.status}</Th>
            </tr>
          </thead>
          <tbody>
            {imports.map((r) => (
              <tr key={r.id}>
                <Td className="font-mono text-xs">{r.file_name}</Td>
                <Td>{r.project_name}</Td>
                <Td className="text-right font-mono">{r.rows_count}</Td>
                <Td className="font-mono text-xs text-muted-foreground">
                  {new Date(r.created_at).toLocaleDateString(numberLocale)}
                </Td>
                <Td>
                  <StatusPill status={r.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      </div>
    </div>
  )
}
