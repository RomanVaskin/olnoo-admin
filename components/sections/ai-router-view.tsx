'use client'

import { startTransition, useEffect, useState } from 'react'
import { SectionHeader, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { checkAiRouterProvider, loadAiRouterCatalog } from '@/app/[locale]/ai-router-actions'
import type { AiRouterCatalog, AiRouterProvider, AiRouterProviderStatus } from '@/lib/ai-router-admin'

const PROVIDERS: { name: AiRouterProvider; label: string }[] = [
  { name: 'openai', label: 'OpenAI' },
  { name: 'anthropic', label: 'Anthropic' },
  { name: 'gemini', label: 'Gemini' },
  { name: 'deepseek', label: 'DeepSeek' },
  { name: 'qwen', label: 'Qwen' },
]

export function AiRouterView() {
  const { t, locale } = useI18n()
  const labels = t.aiRouter
  const [catalog, setCatalog] = useState<AiRouterCatalog | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState<AiRouterProvider | null>(null)

  useEffect(() => {
    let active = true
    startTransition(() => {
      void loadAiRouterCatalog().then(
        (data) => { if (active) { setCatalog(data); setError(false); setLoading(false) } },
        () => { if (active) { setError(true); setLoading(false) } },
      )
    })
    return () => { active = false }
  }, [])

  async function check(name: AiRouterProvider) {
    setChecking(name)
    setError(false)
    try {
      const result = await checkAiRouterProvider(name)
      setCatalog((current) => current ? {
        ...current,
        providers: current.providers.map((row) => row.name === name ? { ...row, ...result } : row),
      } : current)
    } catch {
      setError(true)
    } finally {
      setChecking(null)
    }
  }

  function availability(provider: AiRouterProviderStatus | undefined) {
    if (!provider) return labels.unavailable
    if (!provider.connected) return labels.disconnected
    if (provider.available === null) return labels.unknown
    return provider.available ? labels.available : labels.unavailable
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader index="01" title="AI Router" description={labels.description} />
      {error && <p role="alert" className="text-sm text-destructive">{labels.loadError}</p>}

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-medium">{labels.providers}</h2>
          <span className="label-mono text-muted-foreground">{labels.checkNote}</span>
        </div>
        <TableShell>
          <thead><tr>
            <Th>{labels.provider}</Th><Th>{labels.connection}</Th><Th>{labels.availability}</Th>
            <Th>{labels.lastCheck}</Th><Th>{labels.lastError}</Th><Th>{t.table.actions}</Th>
          </tr></thead>
          <tbody>
            {PROVIDERS.map(({ name, label }) => {
              const provider = catalog?.providers.find((row) => row.name === name)
              return <tr key={name} className="border-t border-hairline">
                <Td><span className="font-medium">{label}</span></Td>
                <Td>{provider ? (provider.connected ? labels.connected : labels.disconnected) : '—'}</Td>
                <Td>{loading ? '—' : availability(provider)}</Td>
                <Td>{provider?.checkedAt ? new Date(provider.checkedAt).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US') : '—'}</Td>
                <Td>{provider?.lastError ?? '—'}</Td>
                <Td><button type="button" onClick={() => void check(name)} disabled={!catalog || checking !== null}
                  className="label-mono border border-hairline px-3 py-1.5 text-foreground transition-colors hover:border-foreground disabled:cursor-not-allowed disabled:opacity-40">
                  {checking === name ? labels.checking : labels.check}
                </button></Td>
              </tr>
            })}
          </tbody>
        </TableShell>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">{labels.assignments}</h2>
        <TableShell>
          <thead><tr><Th>{labels.moduleTask}</Th><Th>{labels.provider}</Th><Th>{labels.model}</Th></tr></thead>
          <tbody>
            {catalog?.presets.map((preset) => <tr key={preset.key} className="border-t border-hairline">
              <Td><span className="font-mono text-xs">{preset.key}</span></Td><Td>{preset.provider}</Td><Td>{preset.model}</Td>
            </tr>)}
            {!loading && !catalog?.presets.length && <tr className="border-t border-hairline"><Td>—</Td><Td>—</Td><Td>—</Td></tr>}
          </tbody>
        </TableShell>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">{labels.models}</h2>
        <TableShell>
          <thead><tr><Th>{labels.provider}</Th><Th>{labels.model}</Th><Th>{labels.purpose}</Th></tr></thead>
          <tbody>
            {catalog?.providers.flatMap((provider) => provider.models.map((model) => <tr key={`${provider.name}:${model.id}`} className="border-t border-hairline">
              <Td>{PROVIDERS.find((entry) => entry.name === provider.name)?.label ?? provider.name}</Td>
              <Td>{model.label} <span className="font-mono text-xs text-muted-foreground">({model.id})</span></Td>
              <Td>{catalog.presets.filter((preset) => preset.provider === provider.name && preset.model === model.id).map((preset) => preset.key).join(', ') || '—'}</Td>
            </tr>))}
          </tbody>
        </TableShell>
      </section>

      <p className="label-mono text-muted-foreground">{labels.costs}: {labels.unavailable} · {labels.balances}: {labels.unavailable}</p>
    </div>
  )
}
