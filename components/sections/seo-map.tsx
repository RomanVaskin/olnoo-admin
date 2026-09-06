'use client'

import { useEffect, useState } from 'react'
import { SectionHeader } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { useProjects, ProjectPicker } from '@/components/sections/seo-project-picker'

type MapItem = {
  keywordId: number
  query: string
  frequency: number | null
  cluster: string | null
  pageId: number | null
  pageUrl: string | null
  status: 'Mapped' | 'Unassigned'
}

type PageOption = { id: number; url: string; locale: string | null; title: string | null }

function pagePath(url: string) {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

function pageOptionLabel(page: PageOption) {
  const parts = [page.locale, pagePath(page.url)].filter(Boolean)
  const base = parts.join(' ')
  return page.title ? `${base} — ${page.title}` : base
}

export function SeoMap() {
  const { t } = useI18n()
  const { projects } = useProjects()
  const [projectId, setProjectId] = useState<number | null>(null)
  const [items, setItems] = useState<MapItem[]>([])
  const [pages, setPages] = useState<PageOption[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (projects.length && projectId === null) setProjectId(projects[0].id)
  }, [projects, projectId])

  useEffect(() => {
    if (projectId === null) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetch(`/api/seo-map?projectId=${projectId}`).then((r) => r.json()),
      fetch(`/api/pages?projectId=${projectId}`).then((r) => r.json()),
    ])
      .then(([mapItems, pageRows]) => {
        if (cancelled) return
        setItems(mapItems)
        setPages(
          pageRows.map((p: any) => ({
            id: p.id,
            url: p.url,
            locale: p.locale ?? null,
            title: p.title ?? null,
          })),
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  async function assign(keywordId: number, pageId: number | null) {
    setItems((prev) =>
      prev.map((it) =>
        it.keywordId === keywordId
          ? {
              ...it,
              pageId,
              pageUrl: pages.find((p) => p.id === pageId)?.url ?? null,
              status: pageId ? 'Mapped' : 'Unassigned',
            }
          : it,
      ),
    )
    await fetch('/api/seo-map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywordId, pageId }),
    })
  }

  const clusters = Array.from(new Set(items.map((i) => i.cluster)))

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="05"
        title={t.seoMap.title}
        description={t.seoMap.description}
        action={<ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />}
      />

      {!loading && items.length === 0 && (
        <p className="label-mono text-muted-foreground">{t.seoMap.empty}</p>
      )}

      <div className="flex flex-col gap-px border border-hairline bg-hairline">
        {clusters.map((cluster) => {
          const clusterItems = items.filter((i) => i.cluster === cluster)
          const missing = clusterItems.filter((i) => i.status === 'Unassigned').length
          return (
            <section key={cluster ?? '__unassigned__'} className="bg-card">
              <div className="flex items-center justify-between border-b border-hairline px-6 py-4">
                <span className="label-mono text-foreground">{cluster ?? t.status.Unassigned}</span>
                <span className="label-mono text-muted-foreground">
                  {missing > 0 ? t.seoMap.missing(missing) : t.seoMap.complete}
                </span>
              </div>
              <ul className="flex flex-col">
                {clusterItems.map((item) => {
                  const missingPage = item.status === 'Unassigned'
                  return (
                    <li
                      key={item.keywordId}
                      className="grid grid-cols-1 items-center gap-3 border-b border-hairline px-6 py-4 last:border-b-0 md:grid-cols-[1fr_auto_1.2fr_auto]"
                    >
                      <span className="text-sm text-foreground">{item.query}</span>
                      <span
                        className="font-mono text-muted-foreground max-md:hidden"
                        aria-hidden
                      >
                        →
                      </span>
                      <select
                        value={item.pageId ?? ''}
                        onChange={(e) =>
                          assign(item.keywordId, e.target.value ? Number(e.target.value) : null)
                        }
                        className="appearance-none border border-hairline bg-card px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-blue"
                      >
                        <option value="">{t.seoMap.noPage}</option>
                        {pages.map((p) => (
                          <option key={p.id} value={p.id}>
                            {pageOptionLabel(p)}
                          </option>
                        ))}
                      </select>
                      <span className="inline-flex items-center gap-2 justify-self-start md:justify-self-end">
                        <span
                          className={`size-1.5 rounded-full ${missingPage ? 'bg-destructive' : 'bg-blue'}`}
                          aria-hidden
                        />
                        <span className="label-mono text-foreground/80">
                          {missingPage ? t.status.Unassigned : t.status.Mapped}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
