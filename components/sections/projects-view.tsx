import {
  SectionHeader,
  StatusPill,
  ModuleTags,
  TableShell,
  Th,
  Td,
} from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { projects } from '@/lib/data'

export function ProjectsView() {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="03"
        title={t.projectsView.title}
        description={t.projectsView.description}
        action={
          <button className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground">
            {t.projectsView.newProject}
          </button>
        }
      />

      <TableShell>
        <thead>
          <tr>
            <Th>{t.table.project}</Th>
            <Th>{t.table.domain}</Th>
            <Th>{t.table.client}</Th>
            <Th>{t.table.modules}</Th>
            <Th className="text-right">{t.table.pages}</Th>
            <Th className="text-right">{t.table.keywords}</Th>
            <Th className="text-right">{t.table.leads}</Th>
            <Th>{t.table.status}</Th>
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
