'use client'

import { useEffect, useState } from 'react'
import { SectionHeader } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'

// Mirrors lib/content-factory-settings.ts's CONTENT_FACTORY_MODES — local literal, same reason
// as every other client-bundle-hygiene mirror in this module.
const MODES = ['manual', 'auto_review', 'auto_publish'] as const
type Mode = (typeof MODES)[number]

type Settings = {
  mode: Mode
  language: string
  allowedTopics: string
  maxPostsPerDay: number
  schedule: string
  requiresApproval: boolean
  autoPublish: boolean
}

const DEFAULTS: Settings = {
  mode: 'manual',
  language: '',
  allowedTopics: '',
  maxPostsPerDay: 3,
  schedule: '',
  requiresApproval: true,
  autoPublish: false,
}

export function ContentFactoryAutomationView({
  project,
  onProjectChange,
}: {
  project: string
  onProjectChange: (id: string) => void
}) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<Settings>(DEFAULTS)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setSaved(false)
    setError('')
    if (project === 'all') return
    fetch(`/api/content-factory/settings?project=${encodeURIComponent(project)}`)
      .then((res) => (res.ok ? res.json() : DEFAULTS))
      .then((json) => setSettings({ ...DEFAULTS, ...json }))
      .catch(() => setSettings(DEFAULTS))
  }, [project])

  async function save() {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const res = await fetch(`/api/content-factory/settings?project=${encodeURIComponent(project)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!res.ok) throw new Error(t.contentFactory.automation.saveError)
      setSettings({ ...DEFAULTS, ...(await res.json()) })
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.contentFactory.automation.saveError)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="04"
        title={t.contentFactory.automation.title}
        description={t.contentFactory.automation.description}
        action={<ProjectSelector value={project} onChange={onProjectChange} />}
      />

      {project === 'all' ? (
        <p className="text-sm text-muted-foreground">{t.contentFactory.selectProjectHint}</p>
      ) : (
        <div className="flex max-w-xl flex-col gap-6 border border-hairline bg-card p-6">
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.contentFactory.automation.modeLabel}</span>
            <select
              value={settings.mode}
              onChange={(e) => setSettings((s) => ({ ...s, mode: e.target.value as Mode }))}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {t.contentFactory.automation[m === 'manual' ? 'modeManual' : m === 'auto_review' ? 'modeAutoReview' : 'modeAutoPublish']}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.contentFactory.automation.languageLabel}</span>
            <input
              value={settings.language}
              onChange={(e) => setSettings((s) => ({ ...s, language: e.target.value }))}
              placeholder={t.contentFactory.automation.languagePlaceholder}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.contentFactory.automation.allowedTopicsLabel}</span>
            <input
              value={settings.allowedTopics}
              onChange={(e) => setSettings((s) => ({ ...s, allowedTopics: e.target.value }))}
              placeholder={t.contentFactory.automation.allowedTopicsPlaceholder}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.contentFactory.automation.maxPostsPerDayLabel}</span>
            <input
              type="number"
              min={0}
              value={settings.maxPostsPerDay}
              onChange={(e) => setSettings((s) => ({ ...s, maxPostsPerDay: Number(e.target.value) || 0 }))}
              className="w-32 border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.contentFactory.automation.scheduleLabel}</span>
            <input
              value={settings.schedule}
              onChange={(e) => setSettings((s) => ({ ...s, schedule: e.target.value }))}
              placeholder={t.contentFactory.automation.schedulePlaceholder}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <label className="flex items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={settings.requiresApproval}
              onChange={(e) => setSettings((s) => ({ ...s, requiresApproval: e.target.checked }))}
              className="size-4 accent-foreground"
            />
            {t.contentFactory.automation.requiresApprovalLabel}
          </label>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={settings.autoPublish}
                onChange={(e) => setSettings((s) => ({ ...s, autoPublish: e.target.checked }))}
                className="size-4 accent-foreground"
              />
              {t.contentFactory.automation.autoPublishLabel}
            </label>
            {settings.autoPublish && <p className="text-xs text-destructive">{t.contentFactory.automation.autoPublishWarning}</p>}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && <p className="text-sm text-foreground">{t.contentFactory.automation.saved}</p>}

          <button
            onClick={save}
            disabled={saving}
            className="label-mono w-fit border border-foreground bg-foreground px-4 py-2 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
          >
            {saving ? t.contentFactory.automation.saving : t.contentFactory.automation.save}
          </button>
        </div>
      )}
    </div>
  )
}
