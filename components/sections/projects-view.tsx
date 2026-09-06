import {
  SectionHeader,
  StatusPill,
  ModuleTags,
  TableShell,
  Th,
  Td,
} from '@/components/primitives'
import { projects } from '@/lib/data'

export function ProjectsView() {
  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="03"
        title="Projects"
        description="Connected properties across every client. Each project carries its own domain, module set, page inventory, keyword set and pipeline."
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
            <Th>Client</Th>
            <Th>Modules</Th>
            <Th className="text-right">Pages</Th>
            <Th className="text-right">Keywords</Th>
            <Th className="text-right">Leads</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} className="transition-colors hover:bg-muted/60">
              <Td className="font-medium text-foreground">{p.name}</Td>
              <Td className="font-mono text-xs">{p.domain}</Td>
              <Td className="text-muted-foreground">{p.client}</Td>
              <Td>
                <ModuleTags modules={p.modules} />
              </Td>
              <Td className="text-right font-mono">{p.pages}</Td>
              <Td className="text-right font-mono">{p.keywords}</Td>
              <Td className="text-right font-mono">{p.leads ?? '—'}</Td>
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
