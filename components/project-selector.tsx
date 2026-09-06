'use client'

import { useState } from 'react'
import { projects } from '@/lib/data'

const options = [
  { id: 'all', name: 'All projects', domain: '3 properties' },
  ...projects.map((p) => ({ id: p.id, name: p.name, domain: p.domain })),
]

export function ProjectSelector() {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(options[0])

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-3 border border-hairline bg-card px-4 py-2.5 text-left transition-colors hover:border-foreground/30"
      >
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">{selected.name}</span>
          <span className="label-mono text-muted-foreground">{selected.domain}</span>
        </span>
        <span
          className={`ml-2 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute left-0 top-[calc(100%+4px)] z-20 min-w-full border border-hairline bg-card shadow-sm">
            {options.map((o) => (
              <button
                key={o.id}
                onClick={() => {
                  setSelected(o)
                  setOpen(false)
                }}
                className={`flex w-full flex-col items-start gap-0.5 border-b border-hairline px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/60 ${
                  selected.id === o.id ? 'bg-muted/40' : ''
                }`}
              >
                <span className="whitespace-nowrap text-sm text-foreground">{o.name}</span>
                <span className="label-mono text-muted-foreground">{o.domain}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
