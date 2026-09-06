import { SectionHeader, Metric, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { crmMetrics, leads } from '@/lib/data'

export function ClientCrm() {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="C2"
        title={t.clientCrm.title}
        description={t.clientCrm.description}
      />

      <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-4">
        <Metric label={t.clientCrm.metricTotal} value={crmMetrics.total} />
        <Metric label={t.clientCrm.metricNew} value={crmMetrics.new} accent />
        <Metric label={t.clientCrm.metricInProgress} value={crmMetrics.inProgress} />
        <Metric label={t.clientCrm.metricWon} value={crmMetrics.won} />
      </section>

      <TableShell>
        <thead>
          <tr>
            <Th>{t.table.lead}</Th>
            <Th>{t.table.service}</Th>
            <Th>{t.table.source}</Th>
            <Th>{t.table.status}</Th>
            <Th>{t.table.created}</Th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => (
            <tr key={l.id}>
              <Td className="font-medium text-foreground">{l.name}</Td>
              <Td>{l.service}</Td>
              <Td>
                <span className="label-mono text-muted-foreground">{t.leadSource[l.source]}</span>
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
