'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { TaskPanel, type TaskPanelState } from '@/components/sections/seo-clusters'
import { buildTechnicalSeoFixTask } from '@/lib/technical-seo-fix-task'
import { isSafeExecutorCode } from '@/lib/seo-executor-codes'
import { useExecutorRuns, type AgentRun } from '@/components/sections/use-executor-runs'
import type { Recheck } from '@/lib/seo-health-store'

type CheckStatus = 'OK' | 'Warning' | 'Missing' | 'Error'

type Issue = { severity: 'ERROR' | 'WARNING'; code: string; url?: string; message: string }

type PageCheck = {
  url: string
  httpStatus: number | null
  canonical: string | null
  indexing: 'index' | 'noindex'
  title: string | null
  h1: string | null
  redirectTo: string | null
  inSitemap: true
}

/** An active project that was never checked (from `mode=last`): no SEO result, only enough for a row and «Recheck». */
type NotChecked = { notChecked: true; projectId: number; projectName: string; domain: string; repository: string | null }

type ProjectHealth = {
  projectId: number
  projectName: string
  domain: string
  sitemapUrl: string | null
  site: { status: CheckStatus; httpStatus: number | null }
  robots: { status: CheckStatus; httpStatus: number | null; disallowAll: boolean }
  sitemap: { status: CheckStatus; httpStatus: number | null; urlCount: number | null }
  pages: PageCheck[]
  pagesTruncated: boolean
  issues: Issue[]
  errors: number
  warnings: number
  overall: 'OK' | 'Warning' | 'Error'
  checkedAt: string
  repository?: string | null
  recheck?: Recheck
  notChecked?: false
}

function AgentStatus({ run, error, t }: { run?: AgentRun; error?: string; t: Record<string, string> }) {
  if (error) return <p className="label-mono text-destructive">{t.agentError}: {error}</p>
  if (!run) return null
  const last = run.log.slice(-3)
  return (
    <div className="flex flex-col gap-1">
      <p className="label-mono text-foreground/80">
        {run.status === 'queued' || run.status === 'running' ? t.agentWorking : run.status === 'pr_created' ? t.agentPr : run.status === 'no_changes' ? t.agentNoChanges : `${t.agentError}: ${run.error ?? run.status}`}
        {run.prUrl && <> <a href={run.prUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4">{run.prUrl}</a></>}
      </p>
      {last.length > 0 && <p className="font-mono text-xs text-muted-foreground">{last.join(' · ')}</p>}
    </div>
  )
}

export function SeoHealth() {
  const { t, locale } = useI18n()
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const [rows, setRows] = useState<(ProjectHealth | NotChecked)[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  // The preflight is expensive (up to 100 URLs per project): it runs only when the user presses a button, never on mount.
  // On mount only the SAVED last results are read (`mode=last`: a cheap DB read, no site fetches).
  const [checked, setChecked] = useState(false)
  const [rechecking, setRechecking] = useState<number | null>(null)
  const [recheckError, setRecheckError] = useState<number | null>(null)
  const [fixPanel, setFixPanel] = useState<TaskPanelState | null>(null)
  const { runs: agentRuns, errors: agentError, start: startAgent } = useExecutorRuns()

  useEffect(() => {
    fetch('/api/seo-health?mode=last')
      .then((res) => (res.ok ? res.json() : []))
      .then((saved: (ProjectHealth | NotChecked)[]) => setRows((cur) => (cur.length ? cur : saved)))
      .catch(() => {})
  }, [])

  // Manual recheck of ONE project: only its row is replaced; the response carries the resolved / still failing / new comparison.
  const recheck = (projectId: number) => {
    setRechecking(projectId)
    setRecheckError(null)
    fetch(`/api/seo-health?projectId=${projectId}`)
      .then((res) => {
        if (!res.ok) throw new Error()
        return res.json()
      })
      .then((data: ProjectHealth[]) => {
        if (data[0]) setRows((cur) => cur.map((x) => (x.projectId === projectId ? data[0] : x)))
      })
      .catch(() => setRecheckError(projectId))
      .finally(() => setRechecking(null))
  }

  const runCheck = useCallback(() => {
    setLoading(true)
    setChecked(true)
    setError(null)
    fetch('/api/seo-health')
      .then((res) => {
        if (!res.ok) throw new Error()
        return res.json()
      })
      .then(setRows)
      .catch(() => setError(t.seoHealth.checkError))
      .finally(() => setLoading(false))
  }, [t.seoHealth.checkError])

  const issuesLabel = (r: ProjectHealth) =>
    r.errors + r.warnings === 0 ? '0' : `${r.errors} ${t.seoHealth.errorsWord} · ${r.warnings} ${t.seoHealth.warningsWord}`
  // One prompt per click: a single issue, or all issues of this project (no duplicates, nothing from other projects).
  const openFix = (r: ProjectHealth, issues: Issue[]) => {
    const text = buildTechnicalSeoFixTask({ ...r, repository: r.repository ?? null }, issues)
    if (text) setFixPanel({ title: `${t.seoHealth.fixTaskTitle} — ${r.projectName}`, text })
  }
  const dash = (v: string | number | null) => (v === null || v === '' ? t.seoHealth.missing : v)

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="08"
        title={t.seoHealth.title}
        description={t.seoHealth.description}
        action={
          <button
            onClick={runCheck}
            disabled={loading}
            className="label-mono whitespace-nowrap border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? t.seoHealth.checking : t.seoHealth.checkAll}
          </button>
        }
      />

      {loading && <p className="label-mono text-muted-foreground">{t.seoHealth.checking}</p>}
      {!loading && error && <p className="label-mono text-destructive">{error}</p>}
      {!checked && rows.length === 0 && <p className="label-mono text-muted-foreground">{t.seoHealth.notRun}</p>}
      {checked && !loading && !error && rows.length === 0 && (
        <p className="label-mono text-muted-foreground">{t.seoHealth.empty}</p>
      )}

      {rows.length > 0 && (
        <TableShell>
          <thead>
            <tr>
              <Th>{t.table.project}</Th>
              <Th>{t.table.domain}</Th>
              <Th>{t.seoHealth.siteStatus}</Th>
              <Th>{t.seoHealth.robotsStatus}</Th>
              <Th>{t.seoHealth.sitemapStatus}</Th>
              <Th className="text-right">{t.seoHealth.sitemapUrlCount}</Th>
              <Th>{t.seoHealth.issuesCount}</Th>
              <Th>{t.seoHealth.lastChecked}</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) =>
              r.notChecked ? (
                <tr key={r.projectId} className="transition-colors hover:bg-muted/60">
                  <Td className="font-medium text-foreground">{r.projectName}</Td>
                  <Td className="font-mono text-xs">
                    {r.domain}
                    {r.repository && <span className="ml-2 text-muted-foreground">{r.repository}</span>}
                  </Td>
                  <td colSpan={6} className="label-mono border-b border-hairline px-4 py-3.5 align-middle text-muted-foreground">
                    {t.seoHealth.neverChecked}
                    {recheckError === r.projectId && <span className="ml-3 text-destructive">{t.seoHealth.checkError}</span>}
                  </td>
                  <Td>
                    <button
                      onClick={() => recheck(r.projectId)}
                      disabled={rechecking !== null || loading}
                      className="label-mono whitespace-nowrap text-foreground/80 underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                    >
                      {rechecking === r.projectId ? t.seoHealth.checking : t.seoHealth.recheck}
                    </button>
                  </Td>
                </tr>
              ) : (
              <Fragment key={r.projectId}>
                <tr className="transition-colors hover:bg-muted/60">
                  <Td className="font-medium text-foreground">{r.projectName}</Td>
                  <Td className="font-mono text-xs">{r.domain}</Td>
                  <Td>
                    <StatusPill status={r.site.status} />
                  </Td>
                  <Td>
                    <StatusPill status={r.robots.status} />
                  </Td>
                  <Td>
                    <StatusPill status={r.sitemap.status} />
                  </Td>
                  <Td className="text-right font-mono">{r.sitemap.urlCount ?? '—'}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <StatusPill status={r.overall} />
                      <span className="font-mono text-xs text-muted-foreground">{issuesLabel(r)}</span>
                    </span>
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">
                    {new Date(r.checkedAt).toLocaleString(dateLocale)}
                  </Td>
                  <Td>
                    <button
                      onClick={() => setOpen(open === r.projectId ? null : r.projectId)}
                      aria-expanded={open === r.projectId}
                      className="label-mono whitespace-nowrap text-foreground/80 underline underline-offset-4 hover:text-foreground"
                    >
                      {open === r.projectId ? t.seoHealth.collapse : t.seoHealth.expand}
                    </button>
                  </Td>
                </tr>
                {open === r.projectId && (
                  <tr>
                    <td colSpan={9} className="border-b border-hairline bg-muted/30 px-4 py-3.5">
                      <div className="flex flex-col gap-5 py-2">
                        <p className="font-mono text-xs text-muted-foreground">
                          {t.seoHealth.sitemapSource}: {r.sitemapUrl ?? '—'}
                          {r.sitemap.httpStatus ? ` · HTTP ${r.sitemap.httpStatus}` : ''}
                          {r.robots.httpStatus ? ` · robots.txt HTTP ${r.robots.httpStatus}` : ''}
                          {r.robots.disallowAll ? ` · ${t.seoHealth.robotsClosed}` : ''}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                          <button
                            type="button"
                            onClick={() => recheck(r.projectId)}
                            disabled={rechecking !== null || loading}
                            className="label-mono w-fit border border-foreground px-4 py-2 text-foreground transition-colors hover:bg-foreground hover:text-background disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {rechecking === r.projectId ? t.seoHealth.checking : t.seoHealth.recheck}
                          </button>
                          {recheckError === r.projectId && <span className="label-mono text-destructive">{t.seoHealth.checkError}</span>}
                          {r.recheck && (
                            <span className="label-mono text-muted-foreground">
                              {t.seoHealth.recheckResolved}: {r.recheck.resolved.length} · {t.seoHealth.recheckStill}: {r.recheck.stillFailing.length} · {t.seoHealth.recheckNew}: {r.recheck.newIssues.length}
                            </span>
                          )}
                        </div>
                        {r.recheck && r.recheck.resolved.length > 0 && (
                          <ul className="flex flex-col gap-1.5">
                            {r.recheck.resolved.map((i, n) => (
                              <li key={n} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                                <span className="label-mono text-foreground">RESOLVED</span>
                                <span className="line-through">{i.message}</span>
                                {i.url && <span className="font-mono text-xs text-muted-foreground">{i.url}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                        {r.issues.length === 0 ? (
                          <p className="label-mono text-muted-foreground">{t.seoHealth.noIssues}</p>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => openFix(r, r.issues)}
                              className="label-mono w-fit border border-foreground bg-foreground px-4 py-2 text-background transition-colors hover:bg-transparent hover:text-foreground"
                            >
                              {t.seoHealth.fixAll}
                            </button>
                            {r.repository && r.issues.some((i) => isSafeExecutorCode(i.code)) && (
                              <button
                                type="button"
                                disabled={agentRuns[r.projectId]?.status === 'running' || agentRuns[r.projectId]?.status === 'queued'}
                                onClick={() => startAgent(r.projectId)}
                                className="label-mono w-fit border border-foreground px-4 py-2 transition-colors hover:bg-foreground hover:text-background disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {t.seoHealth.agentFixAll}
                              </button>
                            )}
                            <AgentStatus run={agentRuns[r.projectId]} error={agentError[r.projectId]} t={t.seoHealth} />
                          <ul className="flex flex-col gap-1.5">
                            {r.issues.map((i, n) => (
                              <li key={n} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                                <span className={`label-mono ${i.severity === 'ERROR' ? 'text-destructive' : 'text-muted-foreground'}`}>{i.severity}</span>
                                {r.recheck && (
                                  <span className="label-mono text-foreground">
                                    {r.recheck.newIssues.some((x) => x.code === i.code && (x.url ?? '') === (i.url ?? '')) ? 'NEW' : 'STILL FAILING'}
                                  </span>
                                )}
                                <span>{i.message}</span>
                                {i.url && <span className="font-mono text-xs text-muted-foreground">{i.url}</span>}
                                <button
                                  type="button"
                                  onClick={() => openFix(r, [i])}
                                  className="label-mono text-foreground/80 underline underline-offset-4 hover:text-foreground"
                                >
                                  {t.seoHealth.fix}
                                </button>
                                {r.repository && isSafeExecutorCode(i.code) && (
                                  <button
                                    type="button"
                                    disabled={agentRuns[r.projectId]?.status === 'running' || agentRuns[r.projectId]?.status === 'queued'}
                                    onClick={() => startAgent(r.projectId, [{ code: i.code, ...(i.url ? { url: i.url } : {}) }])}
                                    className="label-mono text-foreground/80 underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                                  >
                                    {t.seoHealth.agentFix}
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                          </>
                        )}
                        {r.pages.length > 0 && (
                          <div className="flex flex-col gap-2">
                            <p className="label-mono text-foreground/80">{t.seoHealth.pagesTitle}</p>
                            <div className="overflow-x-auto">
                              <table className="w-full text-left text-xs">
                                <thead>
                                  <tr className="label-mono text-muted-foreground">
                                    <th className="py-1.5 pr-4 font-normal">{t.seoHealth.colUrl}</th>
                                    <th className="py-1.5 pr-4 font-normal">{t.seoHealth.colHttp}</th>
                                    <th className="py-1.5 pr-4 font-normal">{t.seoHealth.colCanonical}</th>
                                    <th className="py-1.5 pr-4 font-normal">{t.seoHealth.colIndex}</th>
                                    <th className="py-1.5 pr-4 font-normal">{t.seoHealth.colTitle}</th>
                                    <th className="py-1.5 pr-4 font-normal">{t.seoHealth.colH1}</th>
                                    <th className="py-1.5 font-normal">{t.seoHealth.colInSitemap}</th>
                                  </tr>
                                </thead>
                                <tbody className="font-mono">
                                  {r.pages.map((p) => (
                                    <tr key={p.url} className="border-t border-border">
                                      <td className="py-1.5 pr-4">{p.url}</td>
                                      <td className="py-1.5 pr-4">{p.httpStatus ?? '—'}</td>
                                      <td className="py-1.5 pr-4">{dash(p.canonical)}</td>
                                      <td className={`py-1.5 pr-4 ${p.indexing === 'noindex' ? 'text-destructive' : ''}`}>{t.seoHealth[p.indexing]}</td>
                                      <td className="py-1.5 pr-4">{dash(p.title)}</td>
                                      <td className="py-1.5 pr-4">{dash(p.h1)}</td>
                                      <td className="py-1.5">{t.seoHealth.yes}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            {r.pagesTruncated && <p className="label-mono text-muted-foreground">{t.seoHealth.pagesTruncated}</p>}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
              ),
            )}
          </tbody>
        </TableShell>
      )}
      {fixPanel && <TaskPanel panel={fixPanel} onClose={() => setFixPanel(null)} />}
    </div>
  )
}
