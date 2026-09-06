import { SectionHeader, Metric } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
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

export function AdminOverview() {
  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="01"
        title="Overview"
        description="A cross-module snapshot of the OLNOO platform — inventory, semantic coverage and pipeline in one place."
        action={<ProjectSelector />}
      />

      <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-3 lg:grid-cols-5">
        <Metric label="Active projects" value={adminMetrics.activeProjects} />
        <Metric label="SEO pages" value={adminMetrics.seoPages} />
        <Metric label="Keywords" value={adminMetrics.keywords} />
        <Metric label="New leads" value={adminMetrics.newLeads} accent />
        <Metric label="Open leads" value={adminMetrics.openLeads} />
      </section>

      <section className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">Module — SEO</span>
          <div className="border border-hairline bg-card">
            <StatRow label="Pages" value={metrics.pages} />
            <StatRow label="Keywords" value={metrics.keywords} />
            <StatRow label="Missing pages" value={metrics.missingPages} />
            <StatRow label="Coverage" value={`${coverage}%`} />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">Module — CRM</span>
          <div className="border border-hairline bg-card">
            <StatRow label="New leads" value={crmMetrics.new} />
            <StatRow label="In progress" value={crmMetrics.inProgress} />
            <StatRow label="Proposal" value={crmMetrics.proposal} />
            <StatRow label="Won" value={crmMetrics.won} />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">Recent activity</span>
        <div className="border border-hairline bg-card">
          {recentActivity.map((a, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b border-hairline px-6 py-4 last:border-b-0"
            >
              <span className="label-mono w-10 shrink-0 text-muted-foreground">
                {a.module}
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
