import { SectionHeader, Metric, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { crmMetrics, leads, leadSources } from '@/lib/data'

const maxSource = Math.max(...leadSources.map((s) => s.count), 1)

export function CrmOverview() {
  const recent = leads.slice(0, 6)

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="01"
        title="CRM Overview"
        description="Inbound pipeline captured from OLNOO properties — grouped by stage and acquisition source."
        action={<ProjectSelector />}
      />

      <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-4">
        <Metric label="New" value={crmMetrics.new} accent />
        <Metric label="In progress" value={crmMetrics.inProgress} />
        <Metric label="Proposal" value={crmMetrics.proposal} />
        <Metric label="Won" value={crmMetrics.won} />
      </section>

      <section className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">Recent leads</span>
          <TableShell>
            <thead>
              <tr>
                <Th>Lead</Th>
                <Th>Company</Th>
                <Th>Source</Th>
                <Th>Service</Th>
                <Th>Status</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((l) => (
                <tr key={l.id}>
                  <Td className="font-medium text-foreground">{l.name}</Td>
                  <Td className="text-muted-foreground">{l.company}</Td>
                  <Td>
                    <span className="label-mono text-muted-foreground">{l.source}</span>
                  </Td>
                  <Td>{l.service}</Td>
                  <Td>
                    <StatusPill status={l.status} />
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">{l.created}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </div>

        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">By source</span>
          <div className="flex flex-col gap-5 border border-hairline bg-card p-6">
            {leadSources.map((s) => (
              <div key={s.source} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-foreground/90">{s.source}</span>
                  <span className="font-mono text-xs text-muted-foreground">{s.count}</span>
                </div>
                <div className="h-px w-full bg-hairline">
                  <div
                    className="h-px bg-blue"
                    style={{ width: `${(s.count / maxSource) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
