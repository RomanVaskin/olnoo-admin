'use client'

import { useEffect, useState, type ChangeEvent } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'

type PreviewRow = { keyword: string; frequency: number; region: string }
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
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; total: number } | null>(null)
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

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setPreview(null)
    setMessage(null)
    if (!f || projectId === null) return

    setBusy(true)
    try {
      const form = new FormData()
      form.set('projectId', String(projectId))
      form.set('confirm', 'false')
      form.set('file', f)
      const res = await fetch('/api/keywords/import', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setPreview({ rows: data.preview, total: data.total })
    } catch {
      setMessage(t.wordstatImport.parseError)
    } finally {
      setBusy(false)
    }
  }

  async function handleImport() {
    if (!file || projectId === null || !preview) return
    setBusy(true)
    setMessage(null)
    try {
      const form = new FormData()
      form.set('projectId', String(projectId))
      form.set('confirm', 'true')
      form.set('file', file)
      const res = await fetch('/api/keywords/import', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setMessage(t.wordstatImport.importSuccess(data.imported))
      setFile(null)
      setPreview(null)
      loadImports()
    } catch {
      setMessage(t.wordstatImport.importError)
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
                setFile(null)
                setPreview(null)
                setMessage(null)
              }}
            />
          </div>

          <label
            htmlFor="upload"
            className="flex cursor-pointer flex-col items-center justify-center gap-3 border border-dashed border-border bg-card px-6 py-12 text-center transition-colors hover:border-blue"
          >
            <span className="font-mono text-2xl text-muted-foreground">↑</span>
            <span className="text-sm text-foreground">
              {file ? file.name : t.wordstatImport.dropzoneTitle}
            </span>
            <span className="label-mono text-muted-foreground">{t.wordstatImport.dropzoneHint}</span>
            <input
              id="upload"
              type="file"
              accept=".csv,.xlsx"
              className="sr-only"
              onChange={handleFileChange}
            />
          </label>

          <button
            onClick={handleImport}
            disabled={busy || !preview}
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
