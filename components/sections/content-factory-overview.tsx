'use client'

import { useEffect, useState } from 'react'
import { SectionHeader, Metric } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'

type OverviewData = {
  sourcesCount: number
  found: number
  created: number
  published: number
  errors: number
}

/** Read-only, mirrors SocialOverview's shape — a SectionHeader with ProjectSelector in `action`
 * and a metric row. Requires a real project (sources/materials are project-scoped), same as Ads. */
export function ContentFactoryOverview({
  project,
  onProjectChange,
}: {
  project: string
  onProjectChange: (id: string) => void
}) {
  const { t } = useI18n()
  const [data, setData] = useState<OverviewData | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (project === 'all') {
      setData(null)
      setError(false)
      return
    }
    let cancelled = false
    setError(false)
    fetch(`/api/content-factory/overview?project=${encodeURIComponent(project)}`)
      .then((res) => {
        if (!res.ok) throw new Error('failed')
        return res.json()
      })
      .then((json) => {
        if (!cancelled) setData(json as OverviewData)
      })
      .catch(() => {
        if (!cancelled) {
          setData(null)
          setError(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [project])

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="01"
        title={t.contentFactory.overview.title}
        description={t.contentFactory.overview.description}
        action={<ProjectSelector value={project} onChange={onProjectChange} />}
      />

      {project === 'all' ? (
        <p className="text-sm text-muted-foreground">{t.contentFactory.selectProjectHint}</p>
      ) : (
        <>
          {error && <p className="text-sm text-destructive">{t.contentFactory.overview.loadError}</p>}
          <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-5">
            <Metric label={t.contentFactory.overview.metricSources} value={data?.sourcesCount ?? 0} />
            <Metric label={t.contentFactory.overview.metricFound} value={data?.found ?? 0} />
            <Metric label={t.contentFactory.overview.metricCreated} value={data?.created ?? 0} />
            <Metric label={t.contentFactory.overview.metricPublished} value={data?.published ?? 0} accent />
            <Metric label={t.contentFactory.overview.metricErrors} value={data?.errors ?? 0} />
          </section>
        </>
      )}
    </div>
  )
}
