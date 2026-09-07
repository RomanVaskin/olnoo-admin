'use client'

import { useCallback, useEffect, useState } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'

type CheckStatus = 'OK' | 'Missing' | 'Error'

type ProjectHealth = {
  projectId: number
  projectName: string
  domain: string
  site: { status: CheckStatus; httpStatus: number | null }
  sitemap: { status: CheckStatus; httpStatus: number | null; urlCount: number | null }
  checkedAt: string
}

export function SeoHealth() {
  const { t, locale } = useI18n()
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const [rows, setRows] = useState<ProjectHealth[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
              <Th>{t.seoHealth.sitemapStatus}</Th>
              <Th className="text-right">{t.seoHealth.sitemapUrlCount}</Th>
              <Th>{t.seoHealth.lastChecked}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.projectId} className="transition-colors hover:bg-muted/60">
                <Td className="font-medium text-foreground">{r.projectName}</Td>
                <Td className="font-mono text-xs">{r.domain}</Td>
                <Td>
                  <StatusPill status={r.site.status} />
                </Td>
                <Td>
                  <StatusPill status={r.sitemap.status} />
                </Td>
                <Td className="text-right font-mono">{r.sitemap.urlCount ?? '—'}</Td>
                <Td className="font-mono text-xs text-muted-foreground">
                  {new Date(r.checkedAt).toLocaleString(dateLocale)}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  )
}
