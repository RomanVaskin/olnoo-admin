import { SectionHeader, Metric } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'
import {
  adminMetrics,
  metrics,
  crmMetrics,
  clusters,
  recentActivity,
} from '@/lib/data'

const totalKw = clusters.reduce((s, c) => s + c.items.length, 0)
const mapped = clusters.reduce(
  (s, c) => s + c.items.filter((i) => i.status === 'Mapped').length,
  0,
)
const coverage = Math.round((mapped / totalKw) * 100)

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between border-b border-hairline px-6 py-4 last:border-b-0">
      <span className="text-sm text-foreground/90">{label}</span>
      <span className="font-mono text-sm text-foreground">{value}</span>
    </div>
  )
}

export function AdminOverview({
  project,
  onProjectChange,
}: {
  project: string
  onProjectChange: (id: string) => void
}) {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="01"
        title={t.adminOverview.title}
        description={t.adminOverview.description}
        action={<ProjectSelector value={project} onChange={onProjectChange} />}
      />

      <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-3 lg:grid-cols-5">
        <Metric label={t.adminOverview.metricActiveProjects} value={adminMetrics.activeProjects} />
        <Metric label={t.adminOverview.metricSeoPages} value={adminMetrics.seoPages} />
        <Metric label={t.adminOverview.metricKeywords} value={adminMetrics.keywords} />
        <Metric label={t.adminOverview.metricNewLeads} value={adminMetrics.newLeads} accent />
        <Metric label={t.adminOverview.metricOpenLeads} value={adminMetrics.openLeads} />
      </section>

      <section className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">{t.adminOverview.moduleSeo}</span>
          <div className="border border-hairline bg-card">
            <StatRow label={t.adminOverview.statPages} value={metrics.pages} />
            <StatRow label={t.adminOverview.statKeywords} value={metrics.keywords} />
            <StatRow label={t.adminOverview.statMissingPages} value={metrics.missingPages} />
            <StatRow label={t.adminOverview.statCoverage} value={`${coverage}%`} />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">{t.adminOverview.moduleCrm}</span>
          <div className="border border-hairline bg-card">
            <StatRow label={t.adminOverview.statNewLeads} value={crmMetrics.new} />
            <StatRow label={t.adminOverview.statInProgress} value={crmMetrics.inProgress} />
            <StatRow label={t.adminOverview.statProposal} value={crmMetrics.proposal} />
            <StatRow label={t.adminOverview.statWon} value={crmMetrics.won} />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">{t.adminOverview.recentActivity}</span>
        <div className="border border-hairline bg-card">
          {recentActivity.map((a, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b border-hairline px-6 py-4 last:border-b-0"
            >
              <span className="label-mono w-10 shrink-0 text-muted-foreground">
                {t.module[a.module]}
              </span>
              <span className="flex-1 text-sm text-foreground/90">{a.text}</span>
              <span className="label-mono shrink-0 text-muted-foreground">{a.time}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
