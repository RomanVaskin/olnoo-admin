'use client'

import { useEffect, useState } from 'react'
import { SectionHeader, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'

type QueryRow = { query: string; impressions: number; clicks: number; ctr: number | null; avgPosition: number | null }
type PageRow = { path: string; url: string; visits: number }
type Snapshot = { id: number; provider: string; kind: string; dateFrom: string; dateTo: string; takenAt: string; rows: unknown[] }
type SourceState = { status: 'ok'; snapshotId: number; rows: number } | { status: 'not_configured'; reason: string } | { status: 'error'; kind: string; message: string }
type Run = { partial: boolean; webmaster: SourceState; metrika: SourceState }
type Metrics = { impressions: number | null; clicks: number | null; avgPosition: number | null; visits: number | null }
type Snap = { id: number; provider: string; kind: string; takenAt: string; metrics: Metrics }
type Change = { id: number; kind: string; pageUrl: string | null; prUrl: string | null; createdAt: string; issueCodes: string[]; clusterIds: number[]; status: string | null; baseline: Snap | null; after: Snap | null }
type Decision = {
  action: 'FIX' | 'IGNORE' | 'IMPROVE' | 'CREATE_CANDIDATE' | 'NONE'
  clusterId?: number
  pageId?: number
  pageUrl?: string
  clusterName?: string
  reason: string
  evidence: { impressions?: number; avgPosition?: number | null; issueCodes?: string[]; organicVisits?: number; matchedQueries?: number }
}

export function SeoObserver() {
  const { t, locale } = useI18n()
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const { projects } = useProjects()
  const [projectId, setProjectId] = useState<number | null>(null)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [period, setPeriod] = useState<{ dateFrom: string; dateTo: string } | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [changes, setChanges] = useState<Change[]>([])

  // Read-only before/after history from the saved page_changes + snapshots; never calls a provider.
  const loadChanges = (id: number) =>
    fetch(`/api/seo-page-changes?projectId=${id}`)
      .then((res) => (res.ok ? res.json() : { changes: [] }))
      .then((d) => setChanges(d.changes ?? []))
      .catch(() => setChanges([]))

  // Read-only recommendations from the SAVED data (the pure Decision rules); never triggers a provider call.
  const loadDecisions = (id: number) =>
    fetch(`/api/seo-decisions?projectId=${id}`)
      .then((res) => (res.ok ? res.json() : { decisions: [] }))
      .then((d) => setDecisions((d.decisions ?? []).filter((x: Decision) => x.action !== 'NONE')))
      .catch(() => setDecisions([]))

  useEffect(() => {
    if (projects.length && projectId === null) setProjectId(projects[0].id)
  }, [projects, projectId])

  // Opening the screen only reads what was saved earlier — no provider API is called until the button is pressed.
  useEffect(() => {
    if (projectId === null) return
    setRun(null)
    setError(null)
    fetch(`/api/seo-observer?projectId=${projectId}`)
      .then((res) => res.json())
      .then((d) => {
        setSnapshots(d.snapshots ?? [])
        setPeriod(d.dateFrom ? { dateFrom: d.dateFrom, dateTo: d.dateTo } : null)
      })
    loadDecisions(projectId)
    loadChanges(projectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function fetchData() {
    if (projectId === null) return
    setRunning(true)
    setError(null)
    try {
      const res = await fetch('/api/seo-observer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) })
      const d = await res.json()
      if (!res.ok) throw new Error()
      setRun({ partial: d.partial, webmaster: d.webmaster, metrika: d.metrika })
      setSnapshots(d.snapshots ?? [])
      setPeriod({ dateFrom: d.dateFrom, dateTo: d.dateTo })
      loadDecisions(projectId)
      loadChanges(projectId)
    } catch {
      setError(t.seoObserver.runError)
    } finally {
      setRunning(false)
    }
  }

  const fmt = (v: number | null) => (v === null ? '—' : String(v))
  // Only the metrics the snapshot really has: Webmaster → impressions / clicks / avg position, Metrika → visits.
  const metricsText = (s: Snap | null) => {
    if (!s) return t.seoObserver.histNoBaseline
    const m = s.metrics
    return s.provider === 'yandex_metrika' ? `visits ${fmt(m.visits)}` : `impr ${fmt(m.impressions)} · clicks ${fmt(m.clicks)} · pos ${fmt(m.avgPosition)}`
  }

  const queries = snapshots.find((s) => s.provider === 'yandex_webmaster' && s.kind === 'queries')
  const pages = snapshots.find((s) => s.provider === 'yandex_metrika' && s.kind === 'organic_pages')

  const reasons = t.seoObserver.reasons as Record<string, string>
  const evidenceText = (d: Decision) =>
    [
      d.evidence.issueCodes?.length ? d.evidence.issueCodes.join(', ') : null,
      d.evidence.impressions !== undefined ? `${t.seoObserver.recImpressions}: ${d.evidence.impressions}` : null,
      d.evidence.avgPosition != null ? `${t.seoObserver.recPosition}: ${d.evidence.avgPosition}` : null,
      d.evidence.matchedQueries ? `${d.evidence.matchedQueries} ${t.seoObserver.recMatched}` : null,
      d.evidence.organicVisits !== undefined ? `${t.seoObserver.recVisits}: ${d.evidence.organicVisits}` : null,
    ]
      .filter(Boolean)
      .join(' · ')

  const stateNote = (s: SourceState | undefined) => {
    if (!s || s.status === 'ok') return null
    if (s.status === 'not_configured') {
      const reasons = t.seoObserver.reason as Record<string, string>
      return `${t.seoObserver.notConfigured}: ${reasons[s.reason] ?? s.reason}`
    }
    return `${t.seoObserver.errorState}: ${s.kind}`
  }
  const when = (s?: Snapshot) => (s ? `${s.dateFrom} — ${s.dateTo} · ${t.seoObserver.takenAt}: ${new Date(s.takenAt).toLocaleString(dateLocale)}` : null)

  const block = (title: string, snap: Snapshot | undefined, state: SourceState | undefined, body: React.ReactNode) => (
    <section className="flex flex-col gap-3">
      <span className="label-mono text-foreground/80">{title}</span>
      {stateNote(state) && <p className="label-mono text-muted-foreground">{stateNote(state)}</p>}
      {snap ? (
        <>
          <p className="font-mono text-xs text-muted-foreground">{when(snap)}</p>
          {snap.rows.length === 0 ? <p className="label-mono text-muted-foreground">{t.seoObserver.noRows}</p> : body}
        </>
      ) : (
        !stateNote(state) && <p className="label-mono text-muted-foreground">{t.seoObserver.noSnapshot}</p>
      )}
    </section>
  )

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="09"
        title={t.seoObserver.title}
        description={t.seoObserver.description}
        action={
          <button
            onClick={fetchData}
            disabled={running || projectId === null}
            className="label-mono whitespace-nowrap border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? t.seoObserver.fetching : t.seoObserver.fetch}
          </button>
        }
      />

      <div className="max-w-md">
        <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
      </div>
      {period && (
        <p className="label-mono text-muted-foreground">
          {t.seoObserver.period}: {period.dateFrom} — {period.dateTo}
        </p>
      )}
      {error && <p className="label-mono text-destructive">{error}</p>}
      {run?.partial && <p className="label-mono text-muted-foreground">{t.seoObserver.partial}</p>}

      <section className="flex flex-col gap-3">
        <span className="label-mono text-foreground/80">{t.seoObserver.recTitle}</span>
        <p className="text-xs text-muted-foreground">{t.seoObserver.recHint}</p>
        {decisions.length === 0 ? (
          <p className="label-mono text-muted-foreground">{t.seoObserver.recEmpty}</p>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th>{t.seoObserver.recAction}</Th>
                <Th>{t.seoObserver.recTarget}</Th>
                <Th>{t.seoObserver.recReason}</Th>
                <Th>{t.seoObserver.recEvidence}</Th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d, i) => (
                <tr key={i} className="transition-colors hover:bg-muted/60">
                  <Td className="label-mono text-foreground">{(t.seoObserver.actions as Record<string, string>)[d.action]}</Td>
                  <Td className="font-mono text-xs">{d.pageUrl ?? d.clusterName ?? '—'}</Td>
                  <Td className="text-sm">{reasons[d.reason] ?? d.reason}</Td>
                  <Td className="font-mono text-xs text-muted-foreground">{evidenceText(d) || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <span className="label-mono text-foreground/80">{t.seoObserver.histTitle}</span>
        <p className="text-xs text-muted-foreground">{t.seoObserver.histHint}</p>
        {changes.length === 0 ? (
          <p className="label-mono text-muted-foreground">{t.seoObserver.histEmpty}</p>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th>{t.seoObserver.histType}</Th>
                <Th>{t.seoObserver.histTarget}</Th>
                <Th>{t.seoObserver.histWhat}</Th>
                <Th>{t.seoObserver.histPr}</Th>
                <Th>{t.seoObserver.histBaseline}</Th>
                <Th>{t.seoObserver.histAfter}</Th>
                <Th>{t.seoObserver.histStatus}</Th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-muted/60">
                  <Td className="label-mono text-foreground">{c.kind.toUpperCase()}</Td>
                  <Td className="font-mono text-xs">{c.pageUrl ?? t.seoObserver.histProject}<br />{new Date(c.createdAt).toLocaleDateString(dateLocale)}</Td>
                  <Td className="font-mono text-xs">{[...c.issueCodes, ...c.clusterIds.map((x) => `cluster ${x}`)].join(', ') || '—'}</Td>
                  <Td className="font-mono text-xs">{c.prUrl ? <a href={c.prUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4">PR</a> : '—'}</Td>
                  <Td className="font-mono text-xs text-muted-foreground">{metricsText(c.baseline)}</Td>
                  <Td className="font-mono text-xs text-muted-foreground">{c.after ? metricsText(c.after) : t.seoObserver.histWaiting}</Td>
                  <Td className="label-mono">{c.status ?? '—'}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </section>

      {block(
        t.seoObserver.queriesTitle,
        queries,
        run?.webmaster,
        <TableShell>
          <thead>
            <tr>
              <Th>{t.seoObserver.colQuery}</Th>
              <Th className="text-right">{t.seoObserver.colImpressions}</Th>
              <Th className="text-right">{t.seoObserver.colClicks}</Th>
              <Th className="text-right">{t.seoObserver.colCtr}</Th>
              <Th className="text-right">{t.seoObserver.colPosition}</Th>
            </tr>
          </thead>
          <tbody>
            {(queries?.rows as QueryRow[] | undefined)?.map((r) => (
              <tr key={r.query} className="transition-colors hover:bg-muted/60">
                <Td className="text-foreground">{r.query}</Td>
                <Td className="text-right font-mono">{r.impressions}</Td>
                <Td className="text-right font-mono">{r.clicks}</Td>
                <Td className="text-right font-mono">{r.ctr === null ? '—' : `${r.ctr}%`}</Td>
                <Td className="text-right font-mono">{r.avgPosition ?? '—'}</Td>
              </tr>
            ))}
          </tbody>
        </TableShell>,
      )}

      {block(
        t.seoObserver.pagesTitle,
        pages,
        run?.metrika,
        <TableShell>
          <thead>
            <tr>
              <Th>{t.seoObserver.colUrl}</Th>
              <Th className="text-right">{t.seoObserver.colVisits}</Th>
            </tr>
          </thead>
          <tbody>
            {(pages?.rows as PageRow[] | undefined)?.map((r) => (
              <tr key={r.url} className="transition-colors hover:bg-muted/60">
                <Td className="font-mono text-xs">{r.url}</Td>
                <Td className="text-right font-mono">{r.visits}</Td>
              </tr>
            ))}
          </tbody>
        </TableShell>,
      )}
    </div>
  )
}
