'use client'

import { useState } from 'react'
import { OlnooLogo } from '@/components/olnoo-logo'
import { AdminOverview } from '@/components/sections/admin-overview'
import { ClientsView } from '@/components/sections/clients-view'
import { ProjectsView } from '@/components/sections/projects-view'
import { Overview } from '@/components/sections/overview'
import { PagesView } from '@/components/sections/pages-view'
import { KeywordsView } from '@/components/sections/keywords-view'
import { SeoMap } from '@/components/sections/seo-map'
import { WordstatImport } from '@/components/sections/wordstat-import'
import { CrmOverview } from '@/components/sections/crm-overview'
import { LeadsView } from '@/components/sections/leads-view'
import { SettingsView } from '@/components/sections/settings-view'
import { ClientCrm } from '@/components/sections/client-crm'
import {
  ClientOverview,
  ClientPages,
  ClientKeywords,
} from '@/components/sections/client-view'

type Mode = 'admin' | 'client'

type NavItem = {
  id: string
  label: string
  status?: 'active' | 'soon'
  children?: { id: string; label: string }[]
}

type NavGroup = { label?: string; items: NavItem[] }

const adminGroups: NavGroup[] = [
  { items: [{ id: 'admin-overview', label: 'Overview' }] },
  {
    label: 'Workspace',
    items: [
      { id: 'clients', label: 'Clients' },
      { id: 'projects', label: 'Projects' },
    ],
  },
  {
    label: 'Modules',
    items: [
      {
        id: 'seo',
        label: 'SEO',
        status: 'active',
        children: [
          { id: 'seo-overview', label: 'SEO Overview' },
          { id: 'seo-pages', label: 'Pages' },
          { id: 'seo-keywords', label: 'Keywords' },
          { id: 'seo-map', label: 'SEO Map' },
          { id: 'seo-wordstat', label: 'Wordstat Import' },
        ],
      },
      {
        id: 'crm',
        label: 'CRM',
        status: 'active',
        children: [
          { id: 'crm-overview', label: 'CRM Overview' },
          { id: 'crm-leads', label: 'Leads' },
        ],
      },
      { id: 'social', label: 'Social', status: 'soon' },
      { id: 'ads', label: 'Ads', status: 'soon' },
      { id: 'pr', label: 'PR', status: 'soon' },
      { id: 'analytics', label: 'Analytics', status: 'soon' },
    ],
  },
  { label: 'System', items: [{ id: 'settings', label: 'Settings' }] },
]

const clientGroups: NavGroup[] = [
  { items: [{ id: 'client-overview', label: 'Overview' }] },
  {
    label: 'Modules',
    items: [
      {
        id: 'client-seo',
        label: 'SEO',
        status: 'active',
        children: [
          { id: 'client-seo-pages', label: 'Pages' },
          { id: 'client-seo-keywords', label: 'Keywords' },
          { id: 'client-seo-map', label: 'SEO Map' },
        ],
      },
      {
        id: 'client-crm',
        label: 'CRM',
        status: 'active',
        children: [{ id: 'client-crm-leads', label: 'Leads' }],
      },
    ],
  },
]

function childIds(item: NavItem) {
  return item.children?.map((c) => c.id) ?? []
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('admin')
  const [active, setActive] = useState<string>('admin-overview')

  const groups = mode === 'admin' ? adminGroups : clientGroups

  function switchMode(next: Mode) {
    setMode(next)
    setActive(next === 'admin' ? 'admin-overview' : 'client-overview')
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col lg:flex-row">
        {/* Sidebar */}
        <aside className="flex shrink-0 flex-col border-b border-hairline lg:w-64 lg:border-b-0 lg:border-r">
          <div className="flex flex-col gap-1 border-b border-hairline px-6 py-5">
            <OlnooLogo />
            <span className="label-mono text-muted-foreground">OLNOO Admin</span>
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

          <nav className="flex flex-col gap-5 py-5 lg:flex-1">
            {groups.map((group, gi) => (
              <div key={group.label ?? `g-${gi}`} className="flex flex-col">
                {group.label && (
                  <span className="label-mono px-6 pb-2 text-muted-foreground/70">
                    {group.label}
                  </span>
                )}
                {group.items.map((item) => {
                  const isModule = !!item.children
                  const inModule = childIds(item).includes(active)
                  const soon = item.status === 'soon'
                  const selfActive = active === item.id

                  return (
                    <div key={item.id} className="flex flex-col">
                      <button
                        onClick={() => {
                          if (soon) return
                          setActive(isModule ? item.children![0].id : item.id)
                        }}
                        disabled={soon}
                        className={`flex items-center gap-3 px-6 py-2.5 text-left text-sm transition-colors ${
                          soon
                            ? 'cursor-default text-muted-foreground/50'
                            : selfActive || inModule
                              ? 'text-foreground'
                              : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <span>{item.label}</span>
                        {item.status === 'active' && (
                          <span
                            className="ml-1 size-1.5 rounded-full bg-blue"
                            aria-label="Active module"
                          />
                        )}
                        {soon && (
                          <span className="label-mono ml-auto text-muted-foreground/50">
                            Soon
                          </span>
                        )}
                        {!isModule && selfActive && (
                          <span className="ml-auto h-4 w-px bg-blue" aria-hidden />
                        )}
                      </button>

                      {isModule && inModule && (
                        <div className="mb-1 flex flex-col border-l border-hairline">
                          {item.children!.map((c) => (
                            <button
                              key={c.id}
                              onClick={() => setActive(c.id)}
                              className={`flex items-center py-2 pl-8 pr-6 text-left text-[13px] transition-colors ${
                                active === c.id
                                  ? 'text-foreground'
                                  : 'text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              <span>{c.label}</span>
                              {active === c.id && (
                                <span className="ml-auto h-3.5 w-px bg-blue" aria-hidden />
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </nav>

          <div className="hidden border-t border-hairline px-6 py-4 lg:block">
            <p className="label-mono text-muted-foreground">
              {mode === 'admin' ? 'Workspace · Berlin' : 'Read-only client cabinet'}
            </p>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 px-6 py-10 md:px-10 lg:px-14">
          <div className="mb-8 flex items-center justify-between">
            <span className="label-mono text-muted-foreground">
              {mode === 'admin' ? 'Admin console' : 'Client cabinet'}
            </span>
            <span className="label-mono text-muted-foreground">olnoo.com / admin</span>
          </div>

          {/* Admin */}
          {active === 'admin-overview' && <AdminOverview />}
          {active === 'clients' && <ClientsView />}
          {active === 'projects' && <ProjectsView />}
          {active === 'seo-overview' && <Overview />}
          {active === 'seo-pages' && <PagesView />}
          {active === 'seo-keywords' && <KeywordsView />}
          {active === 'seo-map' && <SeoMap />}
          {active === 'seo-wordstat' && <WordstatImport />}
          {active === 'crm-overview' && <CrmOverview />}
          {active === 'crm-leads' && <LeadsView />}
          {active === 'settings' && <SettingsView />}

          {/* Client */}
          {active === 'client-overview' && <ClientOverview />}
          {active === 'client-seo-pages' && <ClientPages />}
          {active === 'client-seo-keywords' && <ClientKeywords />}
          {active === 'client-seo-map' && <SeoMap />}
          {active === 'client-crm-leads' && <ClientCrm />}
        </main>
      </div>
    </div>
  )
}
