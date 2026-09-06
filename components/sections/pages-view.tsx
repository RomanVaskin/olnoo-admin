import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { pages } from '@/lib/data'

export function PagesView() {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="03"
        title={t.pagesView.title}
        description={t.pagesView.description}
      />

      <TableShell>
        <thead>
          <tr>
            <Th>{t.table.url}</Th>
            <Th>{t.table.title}</Th>
            <Th>{t.table.h1}</Th>
            <Th>{t.table.locale}</Th>
            <Th>{t.table.targetKeyword}</Th>
            <Th>{t.table.status}</Th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.url} className="transition-colors hover:bg-muted/60">
              <Td className="font-mono text-xs text-blue">{p.url}</Td>
              <Td className="max-w-[220px] truncate">{p.title}</Td>
              <Td className="max-w-[180px] truncate text-foreground/80">{p.h1}</Td>
              <Td>
                <span className="label-mono text-muted-foreground">{p.locale}</span>
              </Td>
              <Td className="text-foreground/80">{p.targetKeyword}</Td>
              <Td>
                <StatusPill status={p.status} />
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  )
}
