'use client'

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { SectionHeader, Metric, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { calculateCpl, calculateRoi } from '@/lib/ads-metrics'

const PLATFORMS = ['yandex_direct', 'google_ads', 'vk_ads', 'meta_ads', 'telegram_ads'] as const
const STATUSES = ['draft', 'active', 'paused', 'completed'] as const

type AdsPlatform = (typeof PLATFORMS)[number]
type AdsCampaignStatus = (typeof STATUSES)[number]

type AdsCampaign = {
  id: string
  platform: AdsPlatform
  name: string
  status: AdsCampaignStatus
  budget: number
  spend: number
  impressions: number
  clicks: number
  leads: number
  sales: number
  revenue: number
  utmSource: string
  utmMedium: string
  utmCampaign: string
  startedAt: string
  endedAt: string
  createdAt: string
}

function fromApiCampaign(row: Record<string, unknown>): AdsCampaign {
  return {
    id: row.id as string,
    platform: row.platform as AdsPlatform,
    name: (row.name as string) ?? '',
    status: (row.status as AdsCampaignStatus) ?? 'draft',
    budget: Number(row.budget) || 0,
    spend: Number(row.spend) || 0,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    leads: Number(row.leads) || 0,
    sales: Number(row.sales) || 0,
    revenue: Number(row.revenue) || 0,
    utmSource: (row.utm_source as string) ?? '',
    utmMedium: (row.utm_medium as string) ?? '',
    utmCampaign: (row.utm_campaign as string) ?? '',
    startedAt: (row.started_at as string) ?? '',
    endedAt: (row.ended_at as string) ?? '',
    createdAt: row.created_at as string,
  }
}

function formatMoney(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function formatMetric(value: number | null, suffix = ''): string {
  return value === null ? '—' : `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}${suffix}`
}

function CampaignDetail({
  campaign,
  onClose,
  onSaved,
  onDeleted,
  project,
}: {
  campaign: AdsCampaign
  onClose: () => void
  onSaved: (campaign: AdsCampaign) => void
  onDeleted: (id: string) => void
  project: string
}) {
  const { t } = useI18n()
  const [platform, setPlatform] = useState(campaign.platform)
  const [name, setName] = useState(campaign.name)
  const [status, setStatus] = useState(campaign.status)
  const [budget, setBudget] = useState(String(campaign.budget))
  const [spend, setSpend] = useState(String(campaign.spend))
  const [impressions, setImpressions] = useState(String(campaign.impressions))
  const [clicks, setClicks] = useState(String(campaign.clicks))
  const [leads, setLeads] = useState(String(campaign.leads))
  const [sales, setSales] = useState(String(campaign.sales))
  const [revenue, setRevenue] = useState(String(campaign.revenue))
  const [utmSource, setUtmSource] = useState(campaign.utmSource)
  const [utmMedium, setUtmMedium] = useState(campaign.utmMedium)
  const [utmCampaign, setUtmCampaign] = useState(campaign.utmCampaign)
  const [startedAt, setStartedAt] = useState(campaign.startedAt)
  const [endedAt, setEndedAt] = useState(campaign.endedAt)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setPlatform(campaign.platform)
    setName(campaign.name)
    setStatus(campaign.status)
    setBudget(String(campaign.budget))
    setSpend(String(campaign.spend))
    setImpressions(String(campaign.impressions))
    setClicks(String(campaign.clicks))
    setLeads(String(campaign.leads))
    setSales(String(campaign.sales))
    setRevenue(String(campaign.revenue))
    setUtmSource(campaign.utmSource)
    setUtmMedium(campaign.utmMedium)
    setUtmCampaign(campaign.utmCampaign)
    setStartedAt(campaign.startedAt)
    setEndedAt(campaign.endedAt)
  }, [campaign])

  async function save(patch: Record<string, unknown>) {
    setSaving(true)
    try {
      const res = await fetch(`/api/ads/${campaign.id}?project=${encodeURIComponent(project)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (res.ok) onSaved(fromApiCampaign(await res.json()))
    } finally {
      setSaving(false)
    }
  }

  async function saveAll() {
    await save({
      name,
      budget: Number(budget) || 0,
      spend: Number(spend) || 0,
      impressions: Number(impressions) || 0,
      clicks: Number(clicks) || 0,
      leads: Number(leads) || 0,
      sales: Number(sales) || 0,
      revenue: Number(revenue) || 0,
      utmSource,
      utmMedium,
      utmCampaign,
      startedAt,
      endedAt,
    })
  }

  async function handleDelete() {
    if (!window.confirm(t.adsView.confirmDelete.replace('{name}', campaign.name || campaign.id))) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/ads/${campaign.id}?project=${encodeURIComponent(project)}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        onDeleted(campaign.id)
        onClose()
      }
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-foreground/10" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 z-40 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
          <span className="label-mono text-muted-foreground">{t.adsView.detailLabel}</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-6 px-6 py-6">
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.adsView.platform}</span>
            <select
              value={platform}
              onChange={(e) => {
                const next = e.target.value as AdsPlatform
                setPlatform(next)
                save({ platform: next })
              }}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {t.adsChannel[p]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.adsView.name}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveAll}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <label className="flex items-center justify-between gap-4 border border-hairline bg-card px-4 py-3">
            <span className="label-mono text-muted-foreground">{t.adsView.status}</span>
            <select
              value={status}
              onChange={(e) => {
                const next = e.target.value as AdsCampaignStatus
                setStatus(next)
                save({ status: next })
              }}
              className="label-mono bg-transparent text-right text-foreground focus:outline-none"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t.status[s]}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="label-mono text-muted-foreground">{t.adsView.budget}</span>
              <input
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                onBlur={saveAll}
                inputMode="decimal"
                className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label-mono text-muted-foreground">{t.adsView.spend}</span>
              <input
                value={spend}
                onChange={(e) => setSpend(e.target.value)}
                onBlur={saveAll}
                inputMode="decimal"
                className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label-mono text-muted-foreground">{t.adsView.impressions}</span>
              <input
                value={impressions}
                onChange={(e) => setImpressions(e.target.value)}
                onBlur={saveAll}
                inputMode="numeric"
                className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label-mono text-muted-foreground">{t.adsView.clicks}</span>
              <input
                value={clicks}
                onChange={(e) => setClicks(e.target.value)}
                onBlur={saveAll}
                inputMode="numeric"
                className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label-mono text-muted-foreground">{t.adsView.leads}</span>
              <input
                value={leads}
                onChange={(e) => setLeads(e.target.value)}
                onBlur={saveAll}
                inputMode="numeric"
                className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label-mono text-muted-foreground">{t.adsView.sales}</span>
              <input
                value={sales}
                onChange={(e) => setSales(e.target.value)}
                onBlur={saveAll}
                inputMode="numeric"
                className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1.5">
              <span className="label-mono text-muted-foreground">{t.adsView.revenue}</span>
              <input
                value={revenue}
                onChange={(e) => setRevenue(e.target.value)}
                onBlur={saveAll}
                inputMode="decimal"
                className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.adsView.utmSource}</span>
            <input
              value={utmSource}
              onChange={(e) => setUtmSource(e.target.value)}
              onBlur={saveAll}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.adsView.utmMedium}</span>
            <input
              value={utmMedium}
              onChange={(e) => setUtmMedium(e.target.value)}
              onBlur={saveAll}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.adsView.utmCampaign}</span>
            <input
              value={utmCampaign}
              onChange={(e) => setUtmCampaign(e.target.value)}
              onBlur={saveAll}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="label-mono text-muted-foreground">{t.adsView.startedAt}</span>
              <input
                value={startedAt}
                onChange={(e) => setStartedAt(e.target.value)}
                onBlur={saveAll}
                type="date"
                className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label-mono text-muted-foreground">{t.adsView.endedAt}</span>
              <input
                value={endedAt}
                onChange={(e) => setEndedAt(e.target.value)}
                onBlur={saveAll}
                type="date"
                className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
              />
            </label>
          </div>

          {saving && <span className="label-mono text-muted-foreground">{t.common.saving}</span>}

          <div className="border-t border-hairline pt-6">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="label-mono border border-destructive/40 px-4 py-2.5 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {deleting ? t.common.deleting : t.adsView.deleteCampaign}
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}

function CreateForm({
  project,
  onClose,
  onCreated,
}: {
  project: string
  onClose: () => void
  onCreated: (campaign: AdsCampaign) => void
}) {
  const { t } = useI18n()
  const [platform, setPlatform] = useState<AdsPlatform>('yandex_direct')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/ads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, platform, name }),
      })
      if (!res.ok) throw new Error('failed')
      onCreated(fromApiCampaign(await res.json()))
      onClose()
    } catch {
      setError(t.adsView.createError)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-foreground/10" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 z-40 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
          <span className="label-mono text-muted-foreground">{t.adsView.addCampaign}</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-5 px-6 py-6">
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.adsView.platform}</span>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as AdsPlatform)}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {t.adsChannel[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.adsView.name}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <button
            onClick={submit}
            disabled={saving}
            className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
          >
            {saving ? t.common.saving : t.adsView.addCampaign}
          </button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </aside>
    </>
  )
}

export function AdsView({ project }: { project: string }) {
  const { t } = useI18n()
  const [campaigns, setCampaigns] = useState<AdsCampaign[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<AdsCampaign | null>(null)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [platformFilter, setPlatformFilter] = useState<string>('All')
  const [statusFilter, setStatusFilter] = useState<string>('All')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/ads?project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((rows) => {
        if (cancelled) return
        setCampaigns((rows as Record<string, unknown>[]).map(fromApiCampaign))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project])

  const filtered = useMemo(() => {
    return campaigns.filter((c) => {
      const matchesQuery = !query || c.name.toLowerCase().includes(query.toLowerCase())
      const matchesPlatform = platformFilter === 'All' || c.platform === platformFilter
      const matchesStatus = statusFilter === 'All' || c.status === statusFilter
      return matchesQuery && matchesPlatform && matchesStatus
    })
  }, [campaigns, query, platformFilter, statusFilter])

  const kpis = useMemo(() => {
    const spend = campaigns.reduce((sum, c) => sum + c.spend, 0)
    const leads = campaigns.reduce((sum, c) => sum + c.leads, 0)
    const sales = campaigns.reduce((sum, c) => sum + c.sales, 0)
    const revenue = campaigns.reduce((sum, c) => sum + c.revenue, 0)
    return {
      spend,
      leads,
      sales,
      revenue,
      cpl: calculateCpl(spend, leads),
      roi: calculateRoi(revenue, spend),
    }
  }, [campaigns])

  function handleSaved(updated: AdsCampaign) {
    setCampaigns((current) => current.map((c) => (c.id === updated.id ? updated : c)))
    setSelected(updated)
  }

  function handleDeleted(id: string) {
    setCampaigns((current) => current.filter((c) => c.id !== id))
    setSelected(null)
  }

  function handleCreated(campaign: AdsCampaign) {
    setCampaigns((current) => [campaign, ...current])
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="01"
        title={t.adsView.title}
        description={t.adsView.description}
        action={
          <button
            onClick={() => setCreating(true)}
            className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground"
          >
            {t.adsView.addCampaign}
          </button>
        }
      />

      <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-6">
        <Metric label={t.adsView.kpiSpend} value={formatMoney(kpis.spend)} accent />
        <Metric label={t.adsView.kpiLeads} value={kpis.leads} />
        <Metric label={t.adsView.kpiCpl} value={formatMetric(kpis.cpl)} />
        <Metric label={t.adsView.kpiSales} value={kpis.sales} />
        <Metric label={t.adsView.kpiRevenue} value={formatMoney(kpis.revenue)} />
        <Metric label={t.adsView.kpiRoi} value={formatMetric(kpis.roi, '%')} />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.adsView.searchPlaceholder}
          className="label-mono min-w-[200px] flex-1 border border-hairline bg-card px-4 py-2.5 text-foreground placeholder:text-muted-foreground focus:border-foreground/40 focus:outline-none"
        />
        <label className="flex items-center gap-2 border border-hairline bg-card px-3 py-2">
          <span className="label-mono text-muted-foreground">{t.adsView.filterPlatform}</span>
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            className="label-mono bg-transparent text-foreground focus:outline-none"
          >
            <option value="All">{t.common.all}</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {t.adsChannel[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 border border-hairline bg-card px-3 py-2">
          <span className="label-mono text-muted-foreground">{t.adsView.filterStatus}</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="label-mono bg-transparent text-foreground focus:outline-none"
          >
            <option value="All">{t.common.all}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t.status[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <TableShell>
        <thead>
          <tr>
            <Th>{t.adsView.platform}</Th>
            <Th>{t.adsView.name}</Th>
            <Th>{t.adsView.status}</Th>
            <Th>{t.adsView.spend}</Th>
            <Th>{t.adsView.leads}</Th>
            <Th>{t.adsView.kpiCpl}</Th>
            <Th>{t.adsView.sales}</Th>
            <Th>{t.adsView.revenue}</Th>
            <Th>{t.adsView.kpiRoi}</Th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((c) => (
            <tr
              key={c.id}
              onClick={() => setSelected(c)}
              className="cursor-pointer transition-colors hover:bg-muted/60"
            >
              <Td>
                <span className="label-mono text-muted-foreground">{t.adsChannel[c.platform]}</span>
              </Td>
              <Td className="font-medium text-foreground">{c.name || '—'}</Td>
              <Td>
                <StatusPill status={c.status} />
              </Td>
              <Td className="text-muted-foreground">{formatMoney(c.spend)}</Td>
              <Td className="text-muted-foreground">{c.leads}</Td>
              <Td className="text-muted-foreground">{formatMetric(calculateCpl(c.spend, c.leads))}</Td>
              <Td className="text-muted-foreground">{c.sales}</Td>
              <Td className="text-muted-foreground">{formatMoney(c.revenue)}</Td>
              <Td className="text-muted-foreground">{formatMetric(calculateRoi(c.revenue, c.spend), '%')}</Td>
            </tr>
          ))}
          {!loading && filtered.length === 0 && (
            <tr>
              <Td className="text-muted-foreground">
                <span className="label-mono">{t.adsView.noResults}</span>
              </Td>
              <Td> </Td>
              <Td> </Td>
              <Td> </Td>
              <Td> </Td>
              <Td> </Td>
              <Td> </Td>
              <Td> </Td>
              <Td> </Td>
            </tr>
          )}
        </tbody>
      </TableShell>

      {selected && (
        <CampaignDetail
          campaign={selected}
          project={project}
          onClose={() => setSelected(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
      {creating && <CreateForm project={project} onClose={() => setCreating(false)} onCreated={handleCreated} />}
    </div>
  )
}
