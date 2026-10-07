'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'

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
}

export function SeoHealth() {
  const { t, locale } = useI18n()
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const [rows, setRows] = useState<ProjectHealth[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  const runCheck = useCallback(() => {
    setLoading(true)
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

  useEffect(() => {
    runCheck()
    // Runs once on mount — re-checks are triggered explicitly via the Check all button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const issuesLabel = (r: ProjectHealth) =>
    r.errors + r.warnings === 0 ? '0' : `${r.errors} ${t.seoHealth.errorsWord} · ${r.warnings} ${t.seoHealth.warningsWord}`
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
      {!loading && !error && rows.length === 0 && (
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
            {rows.map((r) => (
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
                        {r.issues.length === 0 ? (
                          <p className="label-mono text-muted-foreground">{t.seoHealth.noIssues}</p>
                        ) : (
                          <ul className="flex flex-col gap-1.5">
                            {r.issues.map((i, n) => (
                              <li key={n} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                                <span className={`label-mono ${i.severity === 'ERROR' ? 'text-destructive' : 'text-muted-foreground'}`}>{i.severity}</span>
                                <span>{i.message}</span>
                                {i.url && <span className="font-mono text-xs text-muted-foreground">{i.url}</span>}
                              </li>
                            ))}
                          </ul>
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
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  )
}
