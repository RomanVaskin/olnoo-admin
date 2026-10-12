'use client'

import { useEffect, useState } from 'react'
import { SectionHeader, Metric, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'

type AccountStatusCounts = { total: number; connected: number; error: number; created: number }

type RecentPublication = {
  id: string
  projectSlug: string
  projectName: string
  postTopic: string
  platform: string
  status: string
  externalUrl: string
  error: string
  publishedAt: string | null
  updatedAt: string
}

type SocialOverviewData = {
  metrics: {
    published: number
    scheduled: number
    accounts: AccountStatusCounts
    publicationErrors: number
  }
  recentPublications: RecentPublication[]
}

/**
 * Read-only — mirrors CrmOverview's shape (SectionHeader with ProjectSelector in `action`, a
 * 4-metric row, a recent-items table). No create/publish action lives here; those stay on
 * Posts/Accounts, each scoped to one explicit project.
 */
export function SocialOverview({
  project,
  onProjectChange,
}: {
  project: string
  onProjectChange: (id: string) => void
}) {
  const { t } = useI18n()
  const [data, setData] = useState<SocialOverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    fetch(`/api/social/overview?project=${encodeURIComponent(project)}`)
      .then((res) => {
        if (!res.ok) throw new Error('failed')
        return res.json()
      })
      .then((json) => {
        if (cancelled) return
        setData(json as SocialOverviewData)
      })
      .catch(() => {
        if (!cancelled) {
          setData(null)
          setError(true)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project])

  const metrics = data?.metrics
  const recent = data?.recentPublications ?? []

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="01"
        title={t.socialOverview.title}
        description={t.socialOverview.description}
        action={<ProjectSelector value={project} onChange={onProjectChange} />}
      />

      {error && <p className="text-sm text-destructive">{t.socialOverview.loadError}</p>}

      <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-4">
        <Metric label={t.socialOverview.metricPublished} value={metrics?.published ?? 0} accent />
        <Metric label={t.socialOverview.metricScheduled} value={metrics?.scheduled ?? 0} />
        <Metric label={t.socialOverview.metricAccounts} value={metrics?.accounts.total ?? 0} />
        <Metric label={t.socialOverview.metricPublicationErrors} value={metrics?.publicationErrors ?? 0} />
      </section>

      <section className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">{t.socialOverview.recentPublications}</span>
          <TableShell>
            <thead>
              <tr>
                <Th>{t.table.project}</Th>
                <Th>Topic</Th>
                <Th>{t.socialAccountsView.platform}</Th>
                <Th>{t.field.status}</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((pub) => (
                <tr key={pub.id}>
                  <Td className="max-w-[140px] truncate text-muted-foreground" title={pub.projectName || pub.projectSlug}>
                    {pub.projectName || pub.projectSlug}
                  </Td>
                  <Td className="font-medium text-foreground">{pub.postTopic}</Td>
                  <Td>
                    <span className="label-mono text-muted-foreground">
                      {t.socialChannel[pub.platform as keyof typeof t.socialChannel] ?? pub.platform}
                    </span>
                  </Td>
                  <Td>
                    <StatusPill status={pub.status} />
                  </Td>
                </tr>
              ))}
              {!loading && recent.length === 0 && (
                <tr>
                  <Td className="text-muted-foreground">
                    <span className="label-mono">{t.socialOverview.noResults}</span>
                  </Td>
                  <Td> </Td>
                  <Td> </Td>
                  <Td> </Td>
                </tr>
              )}
            </tbody>
          </TableShell>
        </div>

        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">{t.socialOverview.accountStatus}</span>
          <div className="flex flex-col gap-5 border border-hairline bg-card p-6">
            {(
              [
                ['accountStatusConnected', metrics?.accounts.connected ?? 0],
                ['accountStatusError', metrics?.accounts.error ?? 0],
                ['accountStatusCreated', metrics?.accounts.created ?? 0],
              ] as const
            ).map(([key, count]) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-sm text-foreground/90">{t.socialOverview[key]}</span>
                <span className="font-mono text-xs text-muted-foreground">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
