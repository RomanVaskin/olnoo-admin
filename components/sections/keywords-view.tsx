import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { keywords } from '@/lib/data'

export function KeywordsView() {
  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="04"
        title="Keywords"
        description="Wordstat demand grouped into clusters and mapped to a target page. Unmapped queries surface as page opportunities."
      />

      <TableShell>
        <thead>
          <tr>
            <Th>Keyword</Th>
            <Th className="text-right">Frequency</Th>
            <Th>Region</Th>
            <Th>Cluster</Th>
            <Th>Target page</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((k) => (
            <tr key={k.keyword} className="transition-colors hover:bg-muted/60">
              <Td className="text-foreground">{k.keyword}</Td>
              <Td className="text-right font-mono">{k.frequency.toLocaleString('ru-RU')}</Td>
              <Td className="text-muted-foreground">{k.region}</Td>
              <Td>
                <span className="label-mono text-foreground/70">{k.cluster}</span>
              </Td>
              <Td
                className={
                  k.targetPage === '—'
                    ? 'font-mono text-xs text-muted-foreground'
                    : 'font-mono text-xs text-blue'
                }
              >
                {k.targetPage}
              </Td>
              <Td>
                <StatusPill status={k.status} />
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  )
}
