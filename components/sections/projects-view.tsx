import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { projects } from '@/lib/data'

export function ProjectsView() {
  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="02"
        title="Projects"
        description="Connected properties and their sync state. Each project carries its own sitemap, page inventory and keyword set."
        action={
          <button className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground">
            New project
          </button>
        }
      />

      <TableShell>
        <thead>
          <tr>
            <Th>Project</Th>
            <Th>Domain</Th>
            <Th>Sitemap</Th>
            <Th className="text-right">Pages</Th>
            <Th className="text-right">Keywords</Th>
            <Th>Status</Th>
            <Th>Last sync</Th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} className="transition-colors hover:bg-muted/60">
              <Td className="font-medium text-foreground">{p.name}</Td>
              <Td className="font-mono text-xs">{p.domain}</Td>
              <Td className="font-mono text-xs text-muted-foreground">{p.sitemap}</Td>
              <Td className="text-right font-mono">{p.pages}</Td>
              <Td className="text-right font-mono">{p.keywords}</Td>
              <Td>
                <StatusPill status={p.status} />
              </Td>
              <Td className="font-mono text-xs text-muted-foreground">{p.lastSync}</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  )
}
