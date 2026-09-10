import type { ReactNode } from 'react'
import { useI18n } from '@/components/i18n-provider'
import type { ModuleKey } from '@/lib/data'

const GOOD = new Set(['Mapped', 'Live', 'Synced', 'Imported', 'Won', 'Active', 'OK', 'connected', 'published'])
const BAD = new Set(['Missing', 'No page', 'Lost', 'Error', 'failed'])

export function StatusPill({ status }: { status: string }) {
  const { t } = useI18n()
  const dot = GOOD.has(status)
    ? 'bg-blue'
    : BAD.has(status)
      ? 'bg-destructive'
      : 'bg-muted-foreground'
  const label = t.status[status as keyof typeof t.status] ?? status

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
      <span className="label-mono text-foreground/80">{label}</span>
    </span>
  )
}

export function ModuleTags({ modules }: { modules: ModuleKey[] }) {
  const { t } = useI18n()
  return (
    <span className="label-mono text-foreground/70">
      {modules.map((m) => t.module[m]).join(' · ')}
    </span>
  )
}

export function SectionHeader({
  index,
  title,
  description,
  action,
}: {
  index: string
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-hairline pb-6 md:flex-row md:items-end md:justify-between">
      <div className="flex items-start gap-4">
        <span className="label-mono mt-1 text-muted-foreground">{index}</span>
        <div className="flex flex-col gap-2">
          <h1 className="text-pretty text-2xl font-medium tracking-tight text-foreground">
            {title}
          </h1>
          {description && (
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </header>
  )
}

export function Metric({
  label,
  value,
  accent,
}: {
  label: string
  value: string | number
  accent?: boolean
}) {
  return (
    <div className="flex flex-col gap-3 border-r border-hairline px-6 py-6 last:border-r-0">
      <span className="label-mono text-muted-foreground">{label}</span>
      <span
        className={`font-mono text-3xl font-light tracking-tight ${accent ? 'text-blue' : 'text-foreground'}`}
      >
        {value}
      </span>
    </div>
  )
}

export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto border border-hairline bg-card">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        {children}
      </table>
    </div>
  )
}

export function Th({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <th
      className={`label-mono border-b border-hairline px-4 py-3 text-left font-normal text-muted-foreground ${className ?? ''}`}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <td
      className={`border-b border-hairline px-4 py-3.5 align-middle text-foreground/90 ${className ?? ''}`}
    >
      {children}
    </td>
  )
}
