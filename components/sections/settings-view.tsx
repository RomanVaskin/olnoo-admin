'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'
import { SectionHeader } from '@/components/primitives'
import { clients, ALL_MODULES, MODULE_STATE, type ModuleKey } from '@/lib/data'

export function SettingsView() {
  const [matrix, setMatrix] = useState<Record<string, Set<ModuleKey>>>(() =>
    Object.fromEntries(clients.map((c) => [c.id, new Set(c.modules)])),
  )

  function toggle(clientId: string, module: ModuleKey) {
    if (MODULE_STATE[module] === 'soon') return
    setMatrix((prev) => {
      const next = new Set(prev[clientId])
      next.has(module) ? next.delete(module) : next.add(module)
      return { ...prev, [clientId]: next }
    })
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="09"
        title="Settings"
        description="Module enablement per client. Active modules can be toggled today; the remaining modules ship in later releases."
      />

      <section className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">Module availability</span>
        <div className="grid grid-cols-2 gap-px border border-hairline bg-hairline sm:grid-cols-3 lg:grid-cols-6">
          {ALL_MODULES.map((m) => (
            <div key={m} className="flex flex-col gap-2 bg-card px-5 py-5">
              <span className="text-sm font-medium text-foreground">{m}</span>
              <span
                className={`label-mono ${MODULE_STATE[m] === 'active' ? 'text-blue' : 'text-muted-foreground'}`}
              >
                {MODULE_STATE[m] === 'active' ? 'Active' : 'Coming later'}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">Enablement matrix</span>
        <div className="overflow-x-auto border border-hairline bg-card">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr>
                <th className="label-mono border-b border-hairline px-4 py-3 text-left font-normal text-muted-foreground">
                  Client
                </th>
                {ALL_MODULES.map((m) => (
                  <th
                    key={m}
                    className="label-mono border-b border-l border-hairline px-4 py-3 text-center font-normal text-muted-foreground"
                  >
                    {m}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td className="border-b border-hairline px-4 py-3.5 font-medium text-foreground">
                    {c.name}
                  </td>
                  {ALL_MODULES.map((m) => {
                    const enabled = matrix[c.id].has(m)
                    const soon = MODULE_STATE[m] === 'soon'
                    return (
                      <td
                        key={m}
                        className="border-b border-l border-hairline px-4 py-3.5 text-center"
                      >
                        <button
                          onClick={() => toggle(c.id, m)}
                          disabled={soon}
                          aria-label={`${enabled ? 'Disable' : 'Enable'} ${m} for ${c.name}`}
                          className={`inline-flex size-4 items-center justify-center border transition-colors ${
                            enabled
                              ? 'border-blue bg-blue text-background'
                              : soon
                                ? 'cursor-not-allowed border-hairline'
                                : 'border-foreground/30 hover:border-foreground'
                          }`}
                        >
                          {enabled && <Check className="size-3" strokeWidth={3} aria-hidden />}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="label-mono text-muted-foreground">
          UI only — Social, Ads, PR and Analytics are locked until their modules ship.
        </p>
      </section>
    </div>
  )
}
