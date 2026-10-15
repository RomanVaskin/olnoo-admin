'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  SectionHeader,
  StatusPill,
  ModuleTags,
  TableShell,
  Th,
  Td,
} from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import type { ModuleKey } from '@/lib/data'

type ProjectRow = {
  id: number
  name: string
  slug: string | null
  domain: string
  sitemap_url: string
  locale: string | null
  repository: string | null
  client_name: string
  status: string
  pages_count: number
  keywords_count: number
  archived_at: string | null
}

type Form = { id: number | null; name: string; slug: string; domain: string; sitemapUrl: string; locale: string; repository: string }
const EMPTY_FORM: Form = { id: null, name: '', slug: '', domain: '', sitemapUrl: '', locale: '', repository: '' }

type BrandVoice = { targetAudience: string; toneStyle: string; verifiedFacts: string; constraints: string; preferredCta: string }
const EMPTY_BRAND_VOICE: BrandVoice = { targetAudience: '', toneStyle: '', verifiedFacts: '', constraints: '', preferredCta: '' }

// Only the SEO module has a real backend so far — CRM/Social/Ads/PR/Analytics stay out of scope here.
const PROJECT_MODULES: ModuleKey[] = ['SEO']

const inputClass = 'w-full border border-hairline bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-blue disabled:opacity-60'
const buttonClass = 'label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50'
const linkButtonClass = 'label-mono whitespace-nowrap text-foreground/80 underline underline-offset-4 hover:text-foreground'

/** OLNOO Social AI Agent 2.0, stage 1 — Brand Profile, edited from this existing Project screen
 * (not a new app), for one already-saved project (hence rendered only when editing, never while
 * creating one). Own independent load/save against /api/projects/brand-voice, same pattern as
 * SeoContextPanel in components/sections/keywords-cleanup.tsx — deliberately not folded into the
 * main project Save button above, so this panel's own save never risks the project's own
 * name/slug/domain fields and vice versa. */
function BrandVoicePanel({ projectId }: { projectId: number }) {
  const { t } = useI18n()
  const c = t.brandVoice
  const [saved, setSaved] = useState<BrandVoice>(EMPTY_BRAND_VOICE)
  const [draft, setDraft] = useState<BrandVoice>(EMPTY_BRAND_VOICE)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setEditing(false)
    setMessage(null)
    fetch(`/api/projects/brand-voice?projectId=${projectId}`)
      .then((res) => res.json())
      .then((data: { voice: BrandVoice }) => {
        setSaved(data.voice)
        setDraft(data.voice)
      })
  }, [projectId])

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/projects/brand-voice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, ...draft }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || c.saveError)
      setSaved(data.voice)
      setDraft(data.voice)
      setEditing(false)
      setMessage(c.savedHint)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : c.saveError)
    } finally {
      setBusy(false)
    }
  }

  const fields: { key: keyof BrandVoice; label: string; hint: string; lines: boolean }[] = [
    { key: 'targetAudience', label: c.targetAudience, hint: c.targetAudienceHint, lines: true },
    { key: 'toneStyle', label: c.toneStyle, hint: c.toneStyleHint, lines: false },
    { key: 'verifiedFacts', label: c.verifiedFacts, hint: c.verifiedFactsHint, lines: true },
    { key: 'constraints', label: c.constraints, hint: c.constraintsHint, lines: true },
    { key: 'preferredCta', label: c.preferredCta, hint: c.preferredCtaHint, lines: false },
  ]
  const empty = fields.every((f) => !saved[f.key])

  return (
    <div className="flex flex-col gap-3 border border-hairline bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="label-mono text-muted-foreground">{c.title}</span>
          <span className="text-xs text-muted-foreground">{c.description}</span>
        </div>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className="label-mono text-blue hover:text-foreground">
            {c.edit}
          </button>
        )}
      </div>
      {empty && !editing && <p className="text-sm text-destructive">{c.empty}</p>}
      <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className={f.lines ? 'md:col-span-1' : ''}>
            <dt className="label-mono text-muted-foreground">{f.label}</dt>
            {editing ? (
              <dd className="mt-1">
                {f.lines ? (
                  <textarea
                    value={draft[f.key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    placeholder={f.hint}
                    rows={4}
                    maxLength={2000}
                    className="w-full border border-hairline bg-background px-3 py-2 text-sm outline-none focus:border-blue"
                  />
                ) : (
                  <input
                    value={draft[f.key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    placeholder={f.hint}
                    maxLength={200}
                    className="w-full border border-hairline bg-background px-3 py-2 text-sm outline-none focus:border-blue"
                  />
                )}
              </dd>
            ) : (
              <dd className="mt-1 whitespace-pre-line">{saved[f.key] || <span className="text-muted-foreground">—</span>}</dd>
            )}
          </div>
        ))}
      </dl>
      {editing && (
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={busy} className="label-mono border border-foreground bg-foreground px-4 py-2 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50">
            {c.save}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(saved)
              setEditing(false)
              setMessage(null)
            }}
            className="label-mono text-foreground/80 underline underline-offset-4 hover:text-foreground"
          >
            {c.cancel}
          </button>
        </div>
      )}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  )
}

export function ProjectsView() {
  const { t } = useI18n()
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [form, setForm] = useState<Form | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The shared registry: active projects by default, archived ones only when explicitly asked for.
  const load = useCallback(() => {
    fetch(showArchived ? '/api/projects?archived=include' : '/api/projects')
      .then((res) => res.json())
      .then(setProjects)
  }, [showArchived])

  useEffect(() => {
    load()
  }, [load])

  async function save() {
    if (!form) return
    setSaving(true)
    setError(null)
    const body = form.id === null
      ? { name: form.name, slug: form.slug || undefined, domain: form.domain, sitemapUrl: form.sitemapUrl || undefined, locale: form.locale || undefined, repository: form.repository || undefined }
      : { name: form.name, domain: form.domain, sitemapUrl: form.sitemapUrl, locale: form.locale, repository: form.repository }
    try {
      const res = await fetch(form.id === null ? '/api/projects' : `/api/projects/${form.id}`, {
        method: form.id === null ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? t.projectsView.saveError)
        return
      }
      setForm(null)
      load()
    } catch {
      setError(t.projectsView.saveError)
    } finally {
      setSaving(false)
    }
  }

  async function setArchived(id: number, archived: boolean) {
    const res = await fetch(`/api/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived }) })
    if (res.ok) load()
  }

  const field = (label: string, key: keyof Form, opts: { hint?: string; disabled?: boolean; placeholder?: string } = {}) => (
    <label className="flex flex-col gap-1.5">
      <span className="label-mono text-muted-foreground">{label}</span>
      <input
        className={inputClass}
        value={form?.[key] ?? ''}
        disabled={opts.disabled}
        placeholder={opts.placeholder}
        onChange={(e) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f))}
      />
      {opts.hint && <span className="text-xs text-muted-foreground">{opts.hint}</span>}
    </label>
  )

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="03"
        title={t.projectsView.title}
        description={t.projectsView.description}
        action={
          <button onClick={() => { setError(null); setForm({ ...EMPTY_FORM }) }} className={buttonClass}>
            {t.projectsView.newProject}
          </button>
        }
      />

      {form && (
        <section className="flex flex-col gap-5 border border-hairline bg-card p-6">
          <span className="label-mono text-foreground/80">{form.id === null ? t.projectsView.newProject : t.projectsView.editProject}</span>
          <div className="grid gap-5 md:grid-cols-2">
            {field(t.projectsView.fieldName, 'name')}
            {field(t.projectsView.fieldSlug, 'slug', { disabled: form.id !== null, hint: t.projectsView.fieldSlugHint, placeholder: form.id === null ? 'my-project' : undefined })}
            {field(t.projectsView.fieldDomain, 'domain', { placeholder: 'https://example.com' })}
            {field(t.projectsView.fieldSitemap, 'sitemapUrl', { hint: t.projectsView.fieldSitemapHint })}
            {field(t.projectsView.fieldLocale, 'locale', { placeholder: 'ru' })}
            {field(t.projectsView.fieldRepository, 'repository', { placeholder: 'owner/repo', hint: t.projectsView.fieldRepositoryHint })}
          </div>
          {error && <p className="label-mono text-destructive">{error}</p>}
          <div className="flex gap-3">
            <button onClick={save} disabled={saving} className={buttonClass}>{t.projectsView.save}</button>
            <button onClick={() => setForm(null)} className={linkButtonClass}>{t.projectsView.cancel}</button>
          </div>
        </section>
      )}

      {form && form.id !== null && <BrandVoicePanel projectId={form.id} />}

      <label className="label-mono flex w-fit items-center gap-2 text-muted-foreground">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        {t.projectsView.showArchived}
      </label>

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
            <Th> </Th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} className={`transition-colors hover:bg-muted/60 ${p.archived_at ? 'opacity-60' : ''}`}>
              <Td className="font-medium text-foreground">
                {p.name}
                <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{p.slug ?? t.projectsView.noSlug}</span>
              </Td>
              <Td className="font-mono text-xs">{p.domain}</Td>
              <Td className="text-muted-foreground">{p.client_name}</Td>
              <Td>
                <ModuleTags modules={PROJECT_MODULES} />
              </Td>
              <Td className="text-right font-mono">{p.pages_count}</Td>
              <Td className="text-right font-mono">{p.keywords_count}</Td>
              <Td className="text-right font-mono">—</Td>
              <Td>{p.archived_at ? <span className="label-mono text-muted-foreground">{t.projectsView.archivedBadge}</span> : <StatusPill status={p.status} />}</Td>
              <Td>
                <span className="flex gap-4">
                  <button
                    onClick={() => { setError(null); setForm({ id: p.id, name: p.name, slug: p.slug ?? '', domain: p.domain, sitemapUrl: p.sitemap_url, locale: p.locale ?? '', repository: p.repository ?? '' }) }}
                    className={linkButtonClass}
                  >
                    {t.projectsView.edit}
                  </button>
                  <button onClick={() => setArchived(p.id, !p.archived_at)} className={linkButtonClass}>
                    {p.archived_at ? t.projectsView.restore : t.projectsView.archive}
                  </button>
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  )
}
