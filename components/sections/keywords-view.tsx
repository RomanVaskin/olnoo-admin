import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { keywords } from '@/lib/data'

export function KeywordsView() {
  const { t, locale } = useI18n()
  const numberLocale = locale === 'ru' ? 'ru-RU' : 'en-US'

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="04"
        title={t.keywordsView.title}
        description={t.keywordsView.description}
      />

      <TableShell>
        <thead>
          <tr>
            <Th>{t.table.keyword}</Th>
            <Th className="text-right">{t.table.frequency}</Th>
            <Th>{t.table.region}</Th>
            <Th>{t.table.cluster}</Th>
            <Th>{t.table.targetPage}</Th>
            <Th>{t.table.status}</Th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((k) => (
            <tr key={k.keyword} className="transition-colors hover:bg-muted/60">
              <Td className="text-foreground">{k.keyword}</Td>
              <Td className="text-right font-mono">{k.frequency.toLocaleString(numberLocale)}</Td>
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
