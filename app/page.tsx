'use client'

import { useState } from 'react'
import { OlnooLogo } from '@/components/olnoo-logo'
import { Overview } from '@/components/sections/overview'
import { ProjectsView } from '@/components/sections/projects-view'
import { PagesView } from '@/components/sections/pages-view'
import { KeywordsView } from '@/components/sections/keywords-view'
import { SeoMap } from '@/components/sections/seo-map'
import { WordstatImport } from '@/components/sections/wordstat-import'
import {
  ClientOverview,
  ClientPages,
  ClientKeywords,
} from '@/components/sections/client-view'

type Mode = 'admin' | 'client'

const adminNav = [
  { id: 'overview', index: '01', label: 'Overview' },
  { id: 'projects', index: '02', label: 'Projects' },
  { id: 'pages', index: '03', label: 'Pages' },
  { id: 'keywords', index: '04', label: 'Keywords' },
  { id: 'seo-map', index: '05', label: 'SEO Map' },
  { id: 'wordstat', index: '06', label: 'Wordstat Import' },
] as const

const clientNav = [
  { id: 'client-overview', index: 'C1', label: 'Client Overview' },
  { id: 'client-pages', index: 'C2', label: 'Client Pages' },
  { id: 'client-keywords', index: 'C3', label: 'Client Keywords' },
] as const

export default function Home() {
  const [mode, setMode] = useState<Mode>('admin')
  const [active, setActive] = useState<string>('overview')

  const nav = mode === 'admin' ? adminNav : clientNav

  function switchMode(next: Mode) {
    setMode(next)
    setActive(next === 'admin' ? 'overview' : 'client-overview')
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col lg:flex-row">
        {/* Sidebar */}
        <aside className="flex shrink-0 flex-col border-b border-hairline lg:w-64 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
            <div className="flex items-center gap-2.5">
              <OlnooLogo />
              <span className="label-mono text-muted-foreground">SEO</span>
            </div>
          </div>

          <div className="flex items-center gap-1 border-b border-hairline px-4 py-3">
            {(['admin', 'client'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={`label-mono flex-1 px-3 py-2 transition-colors ${
                  mode === m
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'admin' ? 'Admin' : 'Client'}
              </button>
            ))}
          </div>

          <nav className="flex flex-col py-2 lg:flex-1">
            {nav.map((item) => (
              <button
                key={item.id}
                onClick={() => setActive(item.id)}
                className={`flex items-center gap-3 px-6 py-3 text-left text-sm transition-colors ${
                  active === item.id
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className="label-mono w-5 text-muted-foreground">{item.index}</span>
                <span>{item.label}</span>
                {active === item.id && (
                  <span className="ml-auto h-4 w-px bg-blue" aria-hidden />
                )}
              </button>
            ))}
          </nav>

          <div className="hidden border-t border-hairline px-6 py-4 lg:block">
            <p className="label-mono text-muted-foreground">
              {mode === 'admin' ? 'Workspace · Berlin' : 'Read-only view'}
            </p>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 px-6 py-10 md:px-10 lg:px-14">
          <div className="mb-8 flex items-center justify-between">
            <span className="label-mono text-muted-foreground">
              {mode === 'admin' ? 'Admin console' : 'Client portal'}
            </span>
            <span className="label-mono text-muted-foreground">olnoo.com / seo</span>
          </div>

          {active === 'overview' && <Overview />}
          {active === 'projects' && <ProjectsView />}
          {active === 'pages' && <PagesView />}
          {active === 'keywords' && <KeywordsView />}
          {active === 'seo-map' && <SeoMap />}
          {active === 'wordstat' && <WordstatImport />}
          {active === 'client-overview' && <ClientOverview />}
          {active === 'client-pages' && <ClientPages />}
          {active === 'client-keywords' && <ClientKeywords />}
        </main>
      </div>
    </div>
  )
}
