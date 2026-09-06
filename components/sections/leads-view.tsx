'use client'

import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { leads, LEAD_STATUSES, type Lead } from '@/lib/data'

const sources = ['All', 'SEO', 'Ads', 'Telegram', 'Direct', 'Referral'] as const

function LeadDetail({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-30 bg-foreground/10" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 z-40 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
          <span className="label-mono text-muted-foreground">Lead</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            Close <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-8 px-6 py-6">
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-medium tracking-tight text-foreground">{lead.name}</h2>
            <span className="text-sm text-muted-foreground">{lead.company}</span>
            <div className="mt-1">
              <StatusPill status={lead.status} />
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <span className="label-mono text-muted-foreground">Enquiry</span>
            <dl className="flex flex-col gap-px border border-hairline bg-hairline">
              <Field label="Email" value={lead.email} mono />
              <Field label="Company" value={lead.company} />
              <Field label="Service" value={lead.service} />
            </dl>
            <p className="border border-hairline bg-card p-4 text-sm leading-relaxed text-foreground/90">
              {lead.message}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <span className="label-mono text-muted-foreground">Source information</span>
            <dl className="flex flex-col gap-px border border-hairline bg-hairline">
              <Field label="Source" value={lead.source} />
              <Field label="Landing page" value={lead.landingPage} mono />
              <Field label="Referrer" value={lead.referrer} mono />
              <Field label="UTM source" value={lead.utmSource} mono />
              <Field label="UTM medium" value={lead.utmMedium} mono />
              <Field label="UTM campaign" value={lead.utmCampaign} mono />
              <Field label="Locale" value={lead.locale} mono />
            </dl>
          </div>

          <div className="flex flex-col gap-3">
            <span className="label-mono text-muted-foreground">CRM</span>
            <dl className="flex flex-col gap-px border border-hairline bg-hairline">
              <Field label="Status" value={lead.status} />
            </dl>
            <p className="border border-hairline bg-card p-4 text-sm leading-relaxed text-foreground/90">
              {lead.notes || 'No notes yet.'}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <span className="label-mono text-muted-foreground">Activity</span>
            <ol className="border border-hairline bg-card">
              {lead.activity.map((a, i) => (
                <li
                  key={i}
                  className="flex gap-4 border-b border-hairline px-4 py-3 last:border-b-0"
                >
                  <span className="label-mono w-14 shrink-0 text-muted-foreground">{a.date}</span>
                  <span className="text-sm text-foreground/90">{a.text}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </aside>
    </>
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

export function LeadsView() {
  const [selected, setSelected] = useState<Lead | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('All')
  const [source, setSource] = useState<string>('All')

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
  }, [query, status, source])

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="02"
        title="Leads"
        description="Every enquiry captured across OLNOO properties, with acquisition context preserved for each record."
        action={
          <button className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground">
            + Add lead
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, company, email"
          className="label-mono min-w-[200px] flex-1 border border-hairline bg-card px-4 py-2.5 text-foreground placeholder:text-muted-foreground focus:border-foreground/40 focus:outline-none"
        />
        <Select value={status} onChange={setStatus} options={['All', ...LEAD_STATUSES]} label="Status" />
        <Select value={source} onChange={setSource} options={[...sources]} label="Source" />
      </div>

      <TableShell>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Company</Th>
            <Th>Email</Th>
            <Th>Service</Th>
            <Th>Source</Th>
            <Th>Landing page</Th>
            <Th>Status</Th>
            <Th>Created</Th>
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
                <span className="label-mono text-muted-foreground">{l.source}</span>
              </Td>
              <Td className="font-mono text-xs text-blue">{l.landingPage}</Td>
              <Td>
                <StatusPill status={l.status} />
              </Td>
              <Td className="font-mono text-xs text-muted-foreground">{l.created}</Td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <Td className="text-muted-foreground" >
                <span className="label-mono">No leads match the current filters.</span>
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

      {selected && <LeadDetail lead={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function Select({
  value,
  onChange,
  options,
  label,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
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
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}
