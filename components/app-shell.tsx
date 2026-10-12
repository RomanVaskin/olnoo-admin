'use client'

import { useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { OlnooLogo } from '@/components/olnoo-logo'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'
import { AdminOverview } from '@/components/sections/admin-overview'
import { ClientsView } from '@/components/sections/clients-view'
import { ProjectsView } from '@/components/sections/projects-view'
import { Overview } from '@/components/sections/overview'
import { PagesView } from '@/components/sections/pages-view'
import { KeywordsView } from '@/components/sections/keywords-view'
import { SeoMap } from '@/components/sections/seo-map'
import { KeywordsCleanup } from '@/components/sections/keywords-cleanup'
import { SeoClusters } from '@/components/sections/seo-clusters'
import { SeoHealth } from '@/components/sections/seo-health'
import { SeoObserver } from '@/components/sections/seo-observer'
import { WordstatImport } from '@/components/sections/wordstat-import'
import { CrmOverview } from '@/components/sections/crm-overview'
import { LeadsView } from '@/components/sections/leads-view'
import { SocialView } from '@/components/sections/social-view'
import { SocialAccountsView } from '@/components/sections/social-accounts-view'
import { AdsView } from '@/components/sections/ads-view'
import { SettingsView } from '@/components/sections/settings-view'
import { ClientCrm } from '@/components/sections/client-crm'
import {
  ClientOverview,
  ClientPages,
  ClientKeywords,
  ClientSeoMap,
} from '@/components/sections/client-view'

type Mode = 'admin' | 'client'

type NavItem = {
  id: string
  status?: 'active' | 'soon'
  children?: { id: string }[]
}

type NavGroup = { groupKey?: 'workspace' | 'modules' | 'system'; items: NavItem[] }

const adminGroups: NavGroup[] = [
  { items: [{ id: 'admin-overview' }] },
  {
    groupKey: 'workspace',
    items: [{ id: 'clients' }, { id: 'projects' }],
  },
  {
    groupKey: 'modules',
    items: [
      {
        id: 'seo',
        status: 'active',
        children: [
          { id: 'seo-overview' },
          { id: 'seo-pages' },
          { id: 'seo-keywords' },
          { id: 'seo-map' },
          { id: 'seo-wordstat' },
          { id: 'seo-cleanup' },
          { id: 'seo-clusters' },
          { id: 'seo-health' },
          { id: 'seo-observer' },
        ],
      },
      {
        id: 'crm',
        status: 'active',
        children: [{ id: 'crm-overview' }, { id: 'crm-leads' }],
      },
      {
        id: 'social',
        status: 'active',
        children: [{ id: 'social-posts' }, { id: 'social-accounts' }],
      },
      { id: 'ads', status: 'active' },
      { id: 'pr', status: 'soon' },
      { id: 'analytics', status: 'soon' },
    ],
  },
  { groupKey: 'system', items: [{ id: 'settings' }] },
]

const clientGroups: NavGroup[] = [
  { items: [{ id: 'client-overview' }] },
  {
    groupKey: 'modules',
    items: [
      {
        id: 'client-seo',
        status: 'active',
        children: [
          { id: 'client-seo-pages' },
          { id: 'client-seo-keywords' },
          { id: 'client-seo-map' },
        ],
      },
      {
        id: 'client-crm',
        status: 'active',
        children: [{ id: 'client-crm-leads' }],
      },
    ],
  },
]

function childIds(item: NavItem) {
  return item.children?.map((c) => c.id) ?? []
}

/** Shown instead of social-posts/social-accounts when no project is explicitly selected yet (see
 * the comment above their render guards) — gives the admin a direct, visible way to pick one
 * right here, rather than requiring them to first go set a project on a different screen (e.g.
 * CRM) and navigate back. Reuses the same ProjectSelector every other project-scoped screen uses;
 * picking a real project here is the only way these two screens render their content. */
function SelectProjectPrompt({ onProjectChange }: { onProjectChange: (id: string) => void }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col items-start gap-4 border border-hairline bg-card px-6 py-10">
      <p className="label-mono text-muted-foreground">{t.shell.selectProjectPrompt}</p>
      <ProjectSelector value="all" onChange={onProjectChange} />
    </div>
  )
}

export function AppShell() {
  const { t } = useI18n()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const mode: Mode = searchParams.get('mode') === 'client' ? 'client' : 'admin'
  const active = searchParams.get('screen') || (mode === 'admin' ? 'admin-overview' : 'client-overview')
  const rawProject = searchParams.get('project')
  const project = rawProject || 'all'

  const updateParams = useCallback(
    (patch: Record<string, string | undefined>) => {
      // Read the live address bar rather than the searchParams snapshot above — this is the same
      // data in the common case, but reading it fresh at the moment of every navigation guarantees
      // an existing param (screen, project, ...) can never be dropped by a stale snapshot.
      const liveSearch = typeof window !== 'undefined' ? window.location.search : `?${searchParams.toString()}`
      const params = new URLSearchParams(liveSearch)
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          params.delete(key)
        } else {
          params.set(key, value)
        }
      }
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  function switchMode(next: Mode) {
    updateParams({
      mode: next === 'admin' ? undefined : next,
      screen: next === 'admin' ? 'admin-overview' : 'client-overview',
    })
  }

  function setActive(id: string) {
    updateParams({ screen: id })
  }

  function setProject(id: string) {
    updateParams({ project: id === 'all' ? undefined : id })
  }

  const groups = mode === 'admin' ? adminGroups : clientGroups

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col lg:flex-row">
        {/* Sidebar */}
        <aside className="flex shrink-0 flex-col border-b border-hairline lg:w-64 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-1 border-b border-hairline px-6 py-5">
            <div className="flex flex-col gap-1">
              <OlnooLogo />
              <span className="label-mono text-muted-foreground">{t.shell.appName}</span>
            </div>
            <LocaleSwitcher />
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
                {m === 'admin' ? t.common.admin : t.common.client}
              </button>
            ))}
          </div>

          <nav className="flex flex-col gap-5 py-5 lg:flex-1">
            {groups.map((group, gi) => (
              <div key={group.groupKey ?? `g-${gi}`} className="flex flex-col">
                {group.groupKey && (
                  <span className="label-mono px-6 pb-2 text-muted-foreground/70">
                    {t.navGroup[group.groupKey]}
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
                        <span>{t.nav[item.id as keyof typeof t.nav]}</span>
                        {item.status === 'active' && (
                          <span
                            className="ml-1 size-1.5 rounded-full bg-blue"
                            aria-label={t.common.activeModule}
                          />
                        )}
                        {soon && (
                          <span className="label-mono ml-auto text-muted-foreground/50">
                            {t.common.soon}
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
                              <span>{t.nav[c.id as keyof typeof t.nav]}</span>
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
              {mode === 'admin' ? t.shell.workspaceBerlin : t.shell.readOnlyClientCabinet}
            </p>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 px-6 py-10 md:px-10 lg:px-14">
          <div className="mb-8 flex items-center justify-between">
            <span className="label-mono text-muted-foreground">
              {mode === 'admin' ? t.shell.adminConsole : t.shell.clientCabinet}
            </span>
            <span className="label-mono text-muted-foreground">olnoo.com / admin</span>
          </div>

          {/* Admin */}
          {active === 'admin-overview' && (
            <AdminOverview project={project} onProjectChange={setProject} />
          )}
          {active === 'clients' && <ClientsView />}
          {active === 'projects' && <ProjectsView />}
          {active === 'seo-overview' && <Overview />}
          {active === 'seo-pages' && <PagesView />}
          {active === 'seo-keywords' && <KeywordsView />}
          {active === 'seo-map' && <SeoMap />}
          {active === 'seo-wordstat' && <WordstatImport />}
          {active === 'seo-cleanup' && <KeywordsCleanup />}
          {active === 'seo-clusters' && <SeoClusters />}
          {active === 'seo-health' && <SeoHealth />}
          {active === 'seo-observer' && <SeoObserver />}
          {active === 'crm-overview' && (
            <CrmOverview project={project} onProjectChange={setProject} />
          )}
          {active === 'crm-leads' && <LeadsView project={project} onProjectChange={setProject} />}
          {/* social-posts/social-accounts/ads cannot function without a real project slug (their
              API calls 400/return nothing for "all") — unlike admin-overview/crm-overview, which
              have their own "All projects" aggregate view. project === 'all' means no project is
              explicitly selected, so these three render nothing rather than fetching with
              project=all (which they can't handle) or guessing which project the admin meant.
              There is deliberately no fallback to a project remembered from a previous, unrelated
              session (e.g. via localStorage): these screens create and publish data (a social
              account, a post, an ad campaign) under whichever project is active, so silently
              reusing a project the admin isn't currently looking at is exactly how a new
              Instagram account or a new post ends up attached to the wrong client. An explicit
              `?project=` in the URL (from a real bookmark/link, or from clicking
              ProjectSelector) is the only source. */}
          {active === 'social-posts' && (
            project !== 'all'
              ? <SocialView project={project} onProjectChange={setProject} />
              : <SelectProjectPrompt onProjectChange={setProject} />
          )}
          {active === 'social-accounts' && (
            project !== 'all'
              ? <SocialAccountsView project={project} onProjectChange={setProject} />
              : <SelectProjectPrompt onProjectChange={setProject} />
          )}
          {active === 'ads' && project !== 'all' && <AdsView project={project} />}
          {active === 'settings' && <SettingsView />}

          {/* Client */}
          {active === 'client-overview' && <ClientOverview />}
          {active === 'client-seo-pages' && <ClientPages />}
          {active === 'client-seo-keywords' && <ClientKeywords />}
          {active === 'client-seo-map' && <ClientSeoMap />}
          {active === 'client-crm-leads' && <ClientCrm />}
        </main>
      </div>
    </div>
  )
}
