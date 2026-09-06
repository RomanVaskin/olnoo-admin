'use client'

import { useState } from 'react'
import { Check, X } from 'lucide-react'
import {
  SectionHeader,
  StatusPill,
  ModuleTags,
  TableShell,
  Th,
  Td,
} from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { pluralizeProjects } from '@/lib/i18n'
import { clients, projects, ALL_MODULES, type Client } from '@/lib/data'

function ClientDetail({ client, onClose }: { client: Client; onClose: () => void }) {
  const { t } = useI18n()
  const clientProjects = projects.filter((p) => p.client === client.name)

  return (
    <>
      <div className="fixed inset-0 z-30 bg-foreground/10" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 z-40 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
          <span className="label-mono text-muted-foreground">{t.clientsView.detailLabel}</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-8 px-6 py-6">
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-medium tracking-tight text-foreground">{client.name}</h2>
            <StatusPill status={client.status} />
          </div>

          <dl className="flex flex-col gap-px border border-hairline bg-hairline">
            <Field label={t.field.contact} value={client.contact} />
            <Field label={t.field.projects} value={String(client.projectCount)} />
            <Field label={t.field.status} value={t.status[client.status]} />
          </dl>

          <div className="flex flex-col gap-3">
            <span className="label-mono text-muted-foreground">{t.clientsView.enabledModules}</span>
            <div className="border border-hairline bg-card">
              {ALL_MODULES.map((m) => {
                const enabled = client.modules.includes(m)
                return (
                  <div
                    key={m}
                    className="flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-b-0"
                  >
                    <span
                      className={`flex size-4 items-center justify-center border ${
                        enabled ? 'border-blue bg-blue text-background' : 'border-hairline'
                      }`}
                      aria-hidden
                    >
                      {enabled && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span className={`text-sm ${enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {t.module[m]}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <span className="label-mono text-muted-foreground">{t.clientsView.projects}</span>
            <div className="border border-hairline bg-card">
              {clientProjects.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between border-b border-hairline px-4 py-3 last:border-b-0"
                >
                  <span className="text-sm text-foreground">{p.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{p.domain}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between bg-card px-4 py-3">
      <dt className="label-mono text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  )
}

export function ClientsView() {
  const { t, locale } = useI18n()
  const [selected, setSelected] = useState<Client | null>(null)

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="02"
        title={t.clientsView.title}
        description={t.clientsView.description}
        action={
          <button className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground">
            {t.clientsView.addClient}
          </button>
        }
      />

      <TableShell>
        <thead>
          <tr>
            <Th>{t.table.client}</Th>
            <Th>{t.table.projects}</Th>
            <Th>{t.table.enabledModules}</Th>
            <Th>{t.table.contact}</Th>
            <Th>{t.table.status}</Th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr
              key={c.id}
              onClick={() => setSelected(c)}
              className="cursor-pointer transition-colors hover:bg-muted/60"
            >
              <Td className="font-medium text-foreground">{c.name}</Td>
              <Td className="font-mono text-xs text-muted-foreground">
                {pluralizeProjects(c.projectCount, locale)}
              </Td>
              <Td>
                <ModuleTags modules={c.modules} />
              </Td>
              <Td className="text-muted-foreground">{c.contact}</Td>
              <Td>
                <StatusPill status={c.status} />
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>

      {selected && <ClientDetail client={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
