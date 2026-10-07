'use client'

import { useEffect, useState } from 'react'

export type SeoProject = {
  id: number
  name: string
  slug: string | null
  domain: string
  /** Default language of the project (Project Registry `projects.locale`), null = not set. */
  locale: string | null
  pagesCount: number
  keywordsCount: number
  status: string
}

/** Active projects from the shared registry (`GET /api/projects`) — the one list every project-based screen uses. */
export function useProjects() {
  const [projects, setProjects] = useState<SeoProject[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/projects')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        setProjects(
          data.map((p: any) => ({
            id: p.id,
            name: p.name,
            slug: p.slug ?? null,
            domain: p.domain,
            locale: p.locale ?? null,
            pagesCount: p.pages_count ?? 0,
            keywordsCount: p.keywords_count ?? 0,
            status: p.status,
          })),
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { projects, loading }
}

export function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: SeoProject[]
  value: number | null
  onChange: (id: number) => void
}) {
  return (
    <div className="relative">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full appearance-none border border-hairline bg-card px-4 py-2.5 pr-8 text-sm text-foreground outline-none focus:border-blue"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} — {p.domain}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
        ▾
      </span>
    </div>
  )
}
