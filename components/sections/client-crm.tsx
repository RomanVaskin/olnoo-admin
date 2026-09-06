import { SectionHeader, Metric, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { crmMetrics, leads } from '@/lib/data'

export function ClientCrm() {
  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="C2"
        title="Leads"
        description="A read-only summary of enquiries captured from your website, prepared by the OLNOO team."
      />

      <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-4">
        <Metric label="Total leads" value={crmMetrics.total} />
        <Metric label="New" value={crmMetrics.new} accent />
        <Metric label="In progress" value={crmMetrics.inProgress} />
        <Metric label="Won" value={crmMetrics.won} />
      </section>

      <TableShell>
        <thead>
          <tr>
            <Th>Lead</Th>
            <Th>Service</Th>
            <Th>Source</Th>
            <Th>Status</Th>
            <Th>Created</Th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => (
            <tr key={l.id}>
              <Td className="font-medium text-foreground">{l.name}</Td>
              <Td>{l.service}</Td>
              <Td>
                <span className="label-mono text-muted-foreground">{l.source}</span>
              </Td>
              <Td>
                <StatusPill status={l.status} />
              </Td>
              <Td className="font-mono text-xs text-muted-foreground">{l.created}</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  )
}
