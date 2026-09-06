import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { pages } from '@/lib/data'

export function PagesView() {
  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="03"
        title="Pages"
        description="Every indexed URL with its title, primary heading, locale and the keyword it is built to rank for."
      />

      <TableShell>
        <thead>
          <tr>
            <Th>URL</Th>
            <Th>Title</Th>
            <Th>H1</Th>
            <Th>Locale</Th>
            <Th>Target keyword</Th>
            <Th>Status</Th>
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
