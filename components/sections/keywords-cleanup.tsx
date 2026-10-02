'use client'

import { useEffect, useRef, useState } from 'react'
import { SectionHeader, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'
import { RELEVANCE_STATUSES, type RelevanceStatus } from '@/lib/keywords-relevance-rules'

type Summary = {
  total: number
  unclassified: number
  target: number
  informational: number
  uncertain: number
  geo_mismatch: number
  irrelevant: number
  manual: number
  disputed: number
  aiDecided: number
  geoAi: number
  pages: number
  seoContext: boolean
  usesCleanup: boolean
}
type SeoContext = { businessType: string; region: string; services: string; plannedServices: string; excluded: string }
const EMPTY_CONTEXT: SeoContext = { businessType: '', region: '', services: '', plannedServices: '', excluded: '' }
type JobView = {
  status: 'running' | 'failed' | 'done'
  totalKeywords: number
  processedKeywords: number
  batchesDone: number
  batchesTotal: number
  error: string | null
  result: { checked: number; downgraded: number; unresolved: number; heldNoContext: number; geoRejected: number } | null
}
type Row = {
  id: number
  query: string
  frequency: number | null
  region: string | null
  status: RelevanceStatus | null
  confidence: number | null
  reason: string | null
  manual: boolean
}
export type RelevanceFilter = 'all' | 'unclassified' | RelevanceStatus

const FILTERS: RelevanceFilter[] = ['all', 'unclassified', 'target', 'informational', 'uncertain', 'geo_mismatch', 'irrelevant']

/** Manual decision control shared by the cleanup table and the Keywords table. */
export function RelevanceSelect({
  status,
  manual,
  disabled,
  onChange,
}: {
  status: RelevanceStatus | null
  manual: boolean
  disabled?: boolean
  onChange: (next: RelevanceStatus | null) => void
}) {
  const { t } = useI18n()
  const r = t.relevance
  return (
    <select
      value={status ?? 'unclassified'}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === 'unclassified' ? null : (e.target.value as RelevanceStatus))}
      className={`label-mono border border-hairline bg-card px-2 py-1 outline-none focus:border-blue disabled:opacity-50 ${manual ? 'text-blue' : 'text-foreground/80'}`}
      title={manual ? r.manual : undefined}
    >
      {status === null && <option value="unclassified">{r.statusOne.unclassified}</option>}
      {RELEVANCE_STATUSES.map((s) => (
        <option key={s} value={s}>
          {r.statusOne[s]}
        </option>
      ))}
      {status !== null && <option value="unclassified">{r.resetOption}</option>}
    </select>
  )
}

export function KeywordsCleanup() {
  const { t, locale } = useI18n()
  const r = t.relevance
  const numberLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const n = (v: number) => v.toLocaleString(numberLocale)
  const { projects } = useProjects()
  const [projectId, setProjectId] = useState<number | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [job, setJob] = useState<JobView | null>(null)
  const [filter, setFilter] = useState<RelevanceFilter>('all')
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const timer = useRef<number | null>(null)
  const filterRef = useRef(filter)
  filterRef.current = filter

  useEffect(() => {
    if (projects.length && projectId === null) setProjectId(projects[0].id)
  }, [projects, projectId])

  const stopPolling = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => stopPolling, [])

  function loadRows(id: number, f: RelevanceFilter, offset = 0) {
    const status = f === 'all' ? '' : `&status=${f}`
    fetch(`/api/keywords/relevance?projectId=${id}&list=1&offset=${offset}${status}`)
      .then((res) => res.json())
      .then((data: { rows: Row[]; total: number }) => {
        setRows((prev) => (offset ? [...prev, ...data.rows] : data.rows))
        setTotal(data.total)
      })
  }

  /** Polls counts + progress; while a run is going also refreshes the table. */
  function refresh(id: number) {
    stopPolling()
    fetch(`/api/keywords/relevance?projectId=${id}`)
      .then((res) => res.json())
      .then((data: { summary: Summary; job: JobView | null }) => {
        setSummary(data.summary)
        setJob(data.job)
        if (data.job?.status === 'running') {
          timer.current = window.setTimeout(() => refresh(id), 2000)
        } else {
          loadRows(id, filterRef.current)
        }
      })
      .catch(() => {
        timer.current = window.setTimeout(() => refresh(id), 4000)
      })
  }

  useEffect(() => {
    if (projectId === null) return
    setJob(null)
    setError(null)
    setRows([])
    refresh(projectId)
  }, [projectId])

  useEffect(() => {
    if (projectId !== null) loadRows(projectId, filter)
  }, [filter])

  async function start(resume = false, requeue?: 'disputed' | 'all' | 'geo') {
    if (projectId === null) return
    setError(null)
    try {
      const res = await fetch('/api/keywords/relevance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, resume, requeue }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || r.saveError)
      setJob(data.job)
      refresh(projectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : r.saveError)
    }
  }

  async function decide(row: Row, next: RelevanceStatus | null) {
    if (projectId === null) return
    setSavingId(row.id)
    setError(null)
    try {
      const res = await fetch('/api/keywords/relevance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, keywordId: row.id, status: next }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || r.saveError)
      refresh(projectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : r.saveError)
    } finally {
      setSavingId(null)
    }
  }

  const running = job?.status === 'running'
  const unclassified = summary?.unclassified ?? 0
  const firstRun = summary ? !summary.usesCleanup : true
  const tiles: { key: RelevanceFilter; label: string; value: number }[] = summary
    ? [
        { key: 'target', label: r.status.target, value: summary.target },
        { key: 'informational', label: r.status.informational, value: summary.informational },
        { key: 'uncertain', label: r.status.uncertain, value: summary.uncertain },
        { key: 'geo_mismatch', label: r.status.geo_mismatch, value: summary.geo_mismatch },
        { key: 'irrelevant', label: r.status.irrelevant, value: summary.irrelevant },
        { key: 'unclassified', label: r.status.unclassified, value: summary.unclassified },
      ]
    : []
  const excluded = summary ? summary.geo_mismatch + summary.irrelevant : 0
  const notClustered = summary && summary.usesCleanup ? summary.uncertain + summary.unclassified : 0

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        index="06"
        title={r.title}
        description={r.description}
        action={
          <div className="flex items-center gap-3">
            <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
            {unclassified > 0 && (
              <button
                onClick={() => void start()}
                disabled={running || projectId === null}
                className="label-mono whitespace-nowrap border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {running ? r.checking : firstRun ? r.checkButton : r.checkNewButton}
              </button>
            )}
          </div>
        }
      />

      {projectId !== null && <SeoContextPanel projectId={projectId} onSaved={() => refresh(projectId)} />}

      {summary && (
        <div className="flex flex-col gap-4 border border-hairline bg-card px-5 py-4">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4 lg:grid-cols-7">
            <div>
              <dt className="label-mono text-muted-foreground">{r.total}</dt>
              <dd className="font-mono text-lg">{n(summary.total)}</dd>
            </div>
            {tiles.map((tile) => (
              <div key={tile.key}>
                <dt className="label-mono text-muted-foreground">{tile.label}</dt>
                <dd className="font-mono text-lg">{n(tile.value)}</dd>
              </div>
            ))}
          </dl>

          {summary.pages === 0 && !summary.seoContext && summary.total > 0 && <p className="text-sm text-destructive">{r.noPagesHint}</p>}
          {!running && summary.usesCleanup && unclassified > 0 && <p className="text-sm">{r.newKeywords(n(unclassified))}</p>}
          {!running && unclassified === 0 && summary.total > 0 && <p className="text-sm text-muted-foreground">{r.allChecked}</p>}
          <p className="text-xs text-muted-foreground">{summary.usesCleanup ? r.usesCleanupHint : r.legacyHint}</p>
          {notClustered > 0 && <p className="text-xs text-muted-foreground">{r.notInClustering(n(notClustered))}</p>}

          {running && job && (
            <div className="flex flex-col gap-2">
              <span className="text-sm">{r.progress.checked(n(job.processedKeywords), n(job.totalKeywords))}</span>
              <span className="font-mono text-xs text-muted-foreground">{r.progress.batch(job.batchesDone, job.batchesTotal)}</span>
              <div className="h-1 w-full max-w-md bg-hairline">
                <div
                  className="h-1 bg-blue transition-all"
                  style={{ width: `${job.totalKeywords ? Math.round((job.processedKeywords / job.totalKeywords) * 100) : 0}%` }}
                />
              </div>
            </div>
          )}
          {job?.status === 'done' && job.result && (
            <div className="flex flex-col gap-1 text-sm">
              <span>{r.progress.doneChecked(n(job.result.checked))}</span>
              {job.result.downgraded > 0 && <span className="text-muted-foreground">{r.progress.doneDowngraded(n(job.result.downgraded))}</span>}
              {job.result.unresolved > 0 && <span className="text-muted-foreground">{r.progress.doneUnresolved(n(job.result.unresolved))}</span>}
              {job.result.geoRejected > 0 && <span className="text-muted-foreground">{r.progress.doneGeoRejected(n(job.result.geoRejected))}</span>}
              {job.result.heldNoContext > 0 && <span className="text-destructive">{r.progress.doneHeld(n(job.result.heldNoContext))}</span>}
            </div>
          )}
          {job?.status === 'failed' && (
            <div className="flex flex-col gap-2">
              <span className="text-sm text-destructive">{job.error}</span>
              <span className="font-mono text-xs text-muted-foreground">{r.progress.batch(job.batchesDone, job.batchesTotal)}</span>
              <button
                type="button"
                onClick={() => void start(true)}
                className="label-mono self-start border border-foreground px-4 py-2 hover:bg-foreground hover:text-background"
              >
                {r.progress.resume}
              </button>
            </div>
          )}

          {!running && (excluded > 0 || summary.uncertain > 0) && (
            <div className="flex flex-wrap gap-4">
              {summary.aiDecided > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(r.recheckAllConfirm(n(summary.aiDecided)))) void start(false, 'all')
                  }}
                  className="label-mono text-destructive hover:text-foreground"
                >
                  {r.recheckAll(n(summary.aiDecided))}
                </button>
              )}
              {summary.geoAi > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(r.recheckGeoConfirm(n(summary.geoAi)))) void start(false, 'geo')
                  }}
                  className="label-mono text-blue hover:text-foreground"
                >
                  {r.recheckGeo(n(summary.geoAi))}
                </button>
              )}
              {summary.disputed > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(r.recheckConfirm(n(summary.disputed)))) void start(false, 'disputed')
                  }}
                  className="label-mono text-blue hover:text-foreground"
                >
                  {r.recheckDisputed(n(summary.disputed))}
                </button>
              )}
              {excluded > 0 && (
                <button type="button" onClick={() => setFilter(summary.irrelevant > 0 ? 'irrelevant' : 'geo_mismatch')} className="label-mono text-blue hover:text-foreground">
                  {r.viewExcluded}
                </button>
              )}
              {summary.uncertain > 0 && (
                <button type="button" onClick={() => setFilter('uncertain')} className="label-mono text-blue hover:text-foreground">
                  {r.viewUncertain}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p className="label-mono text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`label-mono border px-3 py-1.5 transition-colors ${
              filter === f ? 'border-foreground bg-foreground text-background' : 'border-hairline text-muted-foreground hover:text-foreground'
            }`}
          >
            {f === 'all' ? r.filterAll : r.status[f]}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="label-mono text-muted-foreground">{r.empty}</p>
      ) : (
        <TableShell>
          <thead>
            <tr>
              <Th>{t.table.keyword}</Th>
              <Th className="text-right">{t.table.frequency}</Th>
              <Th>{r.decision}</Th>
              <Th className="text-right">{r.confidence}</Th>
              <Th>{r.reason}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="transition-colors hover:bg-muted/60">
                <Td className="text-foreground">{row.query}</Td>
                <Td className="text-right font-mono">{(row.frequency ?? 0).toLocaleString(numberLocale)}</Td>
                <Td>
                  <RelevanceSelect status={row.status} manual={row.manual} disabled={savingId === row.id || running} onChange={(next) => void decide(row, next)} />
                </Td>
                <Td className="text-right font-mono text-xs text-muted-foreground">{row.confidence ?? '—'}</Td>
                <Td className="text-xs text-muted-foreground">{row.reason ?? '—'}</Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
      {rows.length < total && projectId !== null && (
        <button
          type="button"
          onClick={() => loadRows(projectId, filter, rows.length)}
          className="label-mono self-start text-muted-foreground hover:text-foreground"
        >
          {r.loadMore} ({n(rows.length)} / {n(total)})
        </button>
      )}
    </div>
  )
}


/** Project SEO context: what the AI cleanup is told about the business. Saving it never starts any AI work. */
function SeoContextPanel({ projectId, onSaved }: { projectId: number; onSaved: () => void }) {
  const { t } = useI18n()
  const c = t.relevance.context
  const [saved, setSaved] = useState<SeoContext>(EMPTY_CONTEXT)
  const [draft, setDraft] = useState<SeoContext>(EMPTY_CONTEXT)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setEditing(false)
    setMessage(null)
    fetch(`/api/projects/seo-context?projectId=${projectId}`)
      .then((res) => res.json())
      .then((data: { context: SeoContext }) => {
        setSaved(data.context)
        setDraft(data.context)
      })
  }, [projectId])

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/projects/seo-context', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, ...draft }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || c.saveError)
      setSaved(data.context)
      setDraft(data.context)
      setEditing(false)
      setMessage(c.savedHint)
      onSaved()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : c.saveError)
    } finally {
      setBusy(false)
    }
  }

  const fields: { key: keyof SeoContext; label: string; hint: string; lines: boolean }[] = [
    { key: 'businessType', label: c.businessType, hint: c.businessTypeHint, lines: false },
    { key: 'region', label: c.region, hint: c.regionHint, lines: false },
    { key: 'services', label: c.services, hint: c.servicesHint, lines: true },
    { key: 'plannedServices', label: c.plannedServices, hint: c.plannedServicesHint, lines: true },
    { key: 'excluded', label: c.excluded, hint: c.excludedHint, lines: true },
  ]
  const empty = fields.every((f) => !saved[f.key])

  return (
    <div className="flex flex-col gap-3 border border-hairline bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <span className="label-mono text-muted-foreground">{c.title}</span>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className="label-mono text-blue hover:text-foreground">
            {c.edit}
          </button>
        )}
      </div>
      {empty && !editing && <p className="text-sm text-destructive">{c.empty}</p>}
      <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className={f.lines ? 'md:col-span-1' : ''}>
            <dt className="label-mono text-muted-foreground">{f.label}</dt>
            {editing ? (
              <dd className="mt-1">
                {f.lines ? (
                  <textarea
                    value={draft[f.key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    placeholder={f.hint}
                    rows={4}
                    maxLength={2000}
                    className="w-full border border-hairline bg-background px-3 py-2 text-sm outline-none focus:border-blue"
                  />
                ) : (
                  <input
                    value={draft[f.key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    placeholder={f.hint}
                    maxLength={200}
                    className="w-full border border-hairline bg-background px-3 py-2 text-sm outline-none focus:border-blue"
                  />
                )}
              </dd>
            ) : (
              <dd className="mt-1 whitespace-pre-line">{saved[f.key] || <span className="text-muted-foreground">—</span>}</dd>
            )}
          </div>
        ))}
      </dl>
      {editing && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="label-mono border border-foreground bg-foreground px-4 py-2 text-background hover:bg-transparent hover:text-foreground disabled:opacity-50"
          >
            {c.save}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(saved)
              setEditing(false)
            }}
            className="label-mono text-muted-foreground hover:text-foreground"
          >
            {c.cancel}
          </button>
        </div>
      )}
      {message && <p className="label-mono text-muted-foreground">{message}</p>}
    </div>
  )
}
