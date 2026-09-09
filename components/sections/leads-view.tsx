'use client'

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { LEAD_STATUSES, type Lead, type LeadStatus } from '@/lib/data'
import { fromApiLead } from '@/lib/crm-client'

const sources = ['All', 'SEO', 'Ads', 'Telegram', 'Direct', 'Referral'] as const

function LeadDetail({
  lead,
  onClose,
  onSaved,
  onDeleted,
}: {
  lead: Lead
  onClose: () => void
  onSaved: (lead: Lead) => void
  onDeleted: (id: string) => void
}) {
  const { t } = useI18n()
  const [status, setStatus] = useState<LeadStatus>(lead.status)
  const [notes, setNotes] = useState(lead.notes)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setStatus(lead.status)
    setNotes(lead.notes)
  }, [lead])

  async function save(patch: Partial<{ status: LeadStatus; notes: string }>) {
    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (res.ok) onSaved(fromApiLead(await res.json()))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!window.confirm(t.leadsView.confirmDelete.replace('{name}', lead.name))) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}`, { method: 'DELETE' })
      if (res.ok) {
        onDeleted(lead.id)
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
          <span className="label-mono text-muted-foreground">{t.leadsView.detailLabel}</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-8 px-6 py-6">
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-medium tracking-tight text-foreground">{lead.name}</h2>
            <span className="text-sm text-muted-foreground">{lead.company}</span>
            <div className="mt-1">
              <StatusPill status={status} />
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <span className="label-mono text-muted-foreground">{t.leadsView.enquiry}</span>
            <dl className="flex flex-col gap-px border border-hairline bg-hairline">
              <Field label={t.field.email} value={lead.email} mono />
              <Field label={t.field.company} value={lead.company} />
              <Field label={t.field.service} value={lead.service} />
            </dl>
            <p className="border border-hairline bg-card p-4 text-sm leading-relaxed text-foreground/90">
              {lead.message}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <span className="label-mono text-muted-foreground">{t.leadsView.sourceInformation}</span>
            <dl className="flex flex-col gap-px border border-hairline bg-hairline">
              <Field label={t.field.source} value={t.leadSource[lead.source]} />
              <Field label={t.field.landingPage} value={lead.landingPage} mono />
              <Field label={t.field.referrer} value={lead.referrer} mono />
              <Field label={t.field.utmSource} value={lead.utmSource} mono />
              <Field label={t.field.utmMedium} value={lead.utmMedium} mono />
              <Field label={t.field.utmCampaign} value={lead.utmCampaign} mono />
              <Field label={t.field.locale} value={lead.locale} mono />
            </dl>
          </div>

          <div className="flex flex-col gap-3">
            <span className="label-mono text-muted-foreground">{t.leadsView.crm}</span>
            <label className="flex items-center justify-between gap-4 border border-hairline bg-card px-4 py-3">
              <span className="label-mono text-muted-foreground">{t.field.status}</span>
              <select
                value={status}
                onChange={(e) => {
                  const next = e.target.value as LeadStatus
                  setStatus(next)
                  save({ status: next })
                }}
                className="label-mono bg-transparent text-right text-foreground focus:outline-none"
              >
                {LEAD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t.status[s]}
                  </option>
                ))}
              </select>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => save({ notes })}
              placeholder={t.leadsView.noNotes}
              rows={4}
              className="w-full resize-none border border-hairline bg-card p-4 text-sm leading-relaxed text-foreground/90 focus:border-foreground/40 focus:outline-none"
            />
            {saving && <span className="label-mono text-muted-foreground">{t.common.saving}</span>}
          </div>

          <div className="border-t border-hairline pt-6">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="label-mono border border-destructive/40 px-4 py-2.5 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {deleting ? t.common.deleting : t.leadsView.deleteLead}
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}

function LeadCreateForm({ project, onClose, onCreated }: { project: string; onClose: () => void; onCreated: (lead: Lead) => void }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [service, setService] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, name, email, company, service, message, source: 'manual' }),
      })
      if (!res.ok) throw new Error('failed')
      onCreated(fromApiLead(await res.json()))
      onClose()
    } catch {
      setError(t.leadsView.createError)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-foreground/10" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 z-40 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
          <span className="label-mono text-muted-foreground">{t.leadsView.addLead}</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-5 px-6 py-6">
          <CreateField label={t.table.name} value={name} onChange={setName} />
          <CreateField label={t.field.email} value={email} onChange={setEmail} type="email" />
          <CreateField label={t.field.company} value={company} onChange={setCompany} />
          <CreateField label={t.field.service} value={service} onChange={setService} />
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.leadsView.enquiry}</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="resize-none border border-hairline bg-card p-3 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <button
            onClick={submit}
            disabled={saving || !name.trim() || !email.trim()}
            className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
          >
            {saving ? t.common.saving : t.leadsView.addLead}
          </button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </aside>
    </>
  )
}

function CreateField({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label-mono text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
      />
    </label>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 bg-card px-4 py-3">
      <dt className="label-mono shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`truncate text-right text-sm text-foreground ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </dd>
    </div>
  )
}

export function LeadsView({ project }: { project: string }) {
  const { t } = useI18n()
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Lead | null>(null)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('All')
  const [source, setSource] = useState<string>('All')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/leads?project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((rows) => {
        if (cancelled) return
        setLeads((rows as Record<string, unknown>[]).map(fromApiLead))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project])

  const filtered = useMemo(() => {
    return leads.filter((l) => {
      const matchesQuery =
        !query ||
        l.name.toLowerCase().includes(query.toLowerCase()) ||
        l.company.toLowerCase().includes(query.toLowerCase()) ||
        l.email.toLowerCase().includes(query.toLowerCase())
      const matchesStatus = status === 'All' || l.status === status
      const matchesSource = source === 'All' || l.source === source
      return matchesQuery && matchesStatus && matchesSource
    })
  }, [leads, query, status, source])

  const statusOptions = ['All', ...LEAD_STATUSES] as const
  const statusLabel = (v: string) => (v === 'All' ? t.common.all : t.status[v as LeadStatus])
  const sourceLabel = (v: string) =>
    v === 'All' ? t.common.all : t.leadSource[v as Exclude<(typeof sources)[number], 'All'>]

  function handleSaved(updated: Lead) {
    setLeads((current) => current.map((l) => (l.id === updated.id ? updated : l)))
    setSelected(updated)
  }

  function handleDeleted(id: string) {
    setLeads((current) => current.filter((l) => l.id !== id))
    setSelected(null)
  }

  function handleCreated(lead: Lead) {
    setLeads((current) => [lead, ...current])
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="02"
        title={t.leadsView.title}
        description={t.leadsView.description}
        action={
          <button
            onClick={() => setCreating(true)}
            className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground"
          >
            {t.leadsView.addLead}
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.leadsView.searchPlaceholder}
          className="label-mono min-w-[200px] flex-1 border border-hairline bg-card px-4 py-2.5 text-foreground placeholder:text-muted-foreground focus:border-foreground/40 focus:outline-none"
        />
        <Select
          value={status}
          onChange={setStatus}
          options={[...statusOptions]}
          getLabel={statusLabel}
          label={t.leadsView.filterStatus}
        />
        <Select
          value={source}
          onChange={setSource}
          options={[...sources]}
          getLabel={sourceLabel}
          label={t.leadsView.filterSource}
        />
      </div>

      <TableShell>
        <thead>
          <tr>
            <Th>{t.table.name}</Th>
            <Th>{t.table.company}</Th>
            <Th>{t.table.email}</Th>
            <Th>{t.table.service}</Th>
            <Th>{t.table.source}</Th>
            <Th>{t.table.landingPage}</Th>
            <Th>{t.table.status}</Th>
            <Th>{t.table.created}</Th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((l) => (
            <tr
              key={l.id}
              onClick={() => setSelected(l)}
              className="cursor-pointer transition-colors hover:bg-muted/60"
            >
              <Td className="font-medium text-foreground">{l.name}</Td>
              <Td className="text-muted-foreground">{l.company}</Td>
              <Td className="font-mono text-xs">{l.email}</Td>
              <Td>{l.service}</Td>
              <Td>
                <span className="label-mono text-muted-foreground">{t.leadSource[l.source]}</span>
              </Td>
              <Td className="font-mono text-xs text-blue">{l.landingPage}</Td>
              <Td>
                <StatusPill status={l.status} />
              </Td>
              <Td className="font-mono text-xs text-muted-foreground">{l.created}</Td>
            </tr>
          ))}
          {!loading && filtered.length === 0 && (
            <tr>
              <Td className="text-muted-foreground">
                <span className="label-mono">{t.leadsView.noResults}</span>
              </Td>
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
        <LeadDetail
          lead={selected}
          onClose={() => setSelected(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
      {creating && (
        <LeadCreateForm project={project} onClose={() => setCreating(false)} onCreated={handleCreated} />
      )}
    </div>
  )
}

function Select({
  value,
  onChange,
  options,
  getLabel,
  label,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  getLabel: (v: string) => string
  label: string
}) {
  return (
    <label className="flex items-center gap-2 border border-hairline bg-card px-3 py-2">
      <span className="label-mono text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="label-mono bg-transparent text-foreground focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {getLabel(o)}
          </option>
        ))}
      </select>
    </label>
  )
}
