'use client'

import { useEffect, useState } from 'react'
import { StatusPill } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'

const CHANNELS = ['telegram', 'instagram', 'threads', 'vk'] as const
type SocialChannel = (typeof CHANNELS)[number]

type PublicationStatus = 'draft' | 'ready' | 'published' | 'failed'

type Publication = {
  id: string
  socialAccountId: string | null
  platform: SocialChannel
  status: PublicationStatus
  publishedAt: string
  externalUrl: string
  error: string
}

type Account = {
  id: string
  platform: SocialChannel
  name: string
  username: string
}

function fromApiPublication(row: Record<string, unknown>): Publication {
  return {
    id: row.id as string,
    socialAccountId: (row.social_account_id as string | null) ?? null,
    platform: row.platform as SocialChannel,
    status: (row.status as PublicationStatus) ?? 'draft',
    publishedAt: (row.published_at as string) ?? '',
    externalUrl: (row.external_url as string) ?? '',
    error: (row.error as string) ?? '',
  }
}

function fromApiAccount(row: Record<string, unknown>): Account {
  return {
    id: row.id as string,
    platform: row.platform as SocialChannel,
    name: (row.name as string) ?? '',
    username: (row.username as string) ?? '',
  }
}

function formatDateTime(value: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function PublicationRow({
  publication,
  accounts,
  project,
  onUpdated,
}: {
  publication: Publication
  accounts: Account[]
  project: string
  onUpdated: (publication: Publication) => void
}) {
  const { t } = useI18n()
  const [accountId, setAccountId] = useState(publication.socialAccountId ?? '')
  const [externalUrl, setExternalUrl] = useState(publication.externalUrl)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setAccountId(publication.socialAccountId ?? '')
    setExternalUrl(publication.externalUrl)
  }, [publication])

  async function save(patch: Record<string, unknown>) {
    setSaving(true)
    try {
      const res = await fetch(`/api/social-publications/${publication.id}?project=${encodeURIComponent(project)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (res.ok) onUpdated(fromApiPublication(await res.json()))
    } finally {
      setSaving(false)
    }
  }

  const channelAccounts = accounts.filter((a) => a.platform === publication.platform)

  return (
    <div className="flex flex-col gap-3 border border-hairline bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="label-mono text-foreground">{t.socialChannel[publication.platform]}</span>
        <StatusPill status={publication.status} />
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="label-mono text-muted-foreground">{t.socialPublications.account}</span>
        <select
          value={accountId}
          onChange={(e) => {
            const next = e.target.value
            setAccountId(next)
            save({ socialAccountId: next || null })
          }}
          className="label-mono border border-hairline bg-card px-3 py-2 text-foreground focus:border-foreground/40 focus:outline-none"
        >
          <option value="">{t.socialPublications.noAccount}</option>
          {channelAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || a.username || a.id}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="label-mono text-muted-foreground">{t.socialPublications.externalUrl}</span>
        <input
          value={externalUrl}
          onChange={(e) => setExternalUrl(e.target.value)}
          onBlur={() => save({ externalUrl })}
          placeholder="https://…"
          className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
        />
      </label>

      {publication.publishedAt && (
        <span className="label-mono text-muted-foreground">
          {t.socialPublications.publishedAt}: {formatDateTime(publication.publishedAt)}
        </span>
      )}
      {publication.error && <span className="text-sm text-destructive">{publication.error}</span>}

      <div className="flex items-center gap-2 pt-1">
        {publication.status !== 'published' ? (
          <button
            onClick={() => save({ status: 'published', externalUrl })}
            disabled={saving}
            className="label-mono border border-foreground bg-foreground px-3 py-2 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
          >
            {t.socialPublications.markPublished}
          </button>
        ) : (
          <button
            onClick={() => save({ status: 'ready' })}
            disabled={saving}
            className="label-mono border border-hairline px-3 py-2 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
          >
            {t.socialPublications.backToReady}
          </button>
        )}
        {saving && <span className="label-mono text-muted-foreground">{t.common.saving}</span>}
      </div>
    </div>
  )
}

export function SocialPublications({
  postId,
  channels,
  project,
}: {
  postId: string
  channels: string[]
  project: string
}) {
  const { t } = useI18n()
  const [publications, setPublications] = useState<Publication[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const channelsKey = channels.join(',')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetch(`/api/social-publications?post=${encodeURIComponent(postId)}&project=${encodeURIComponent(project)}`).then(
        (r) => r.json(),
      ),
      fetch(`/api/social-accounts?project=${encodeURIComponent(project)}`).then((r) => r.json()),
    ])
      .then(([publicationRows, accountRows]) => {
        if (cancelled) return
        setPublications((publicationRows as Record<string, unknown>[]).map(fromApiPublication))
        setAccounts((accountRows as Record<string, unknown>[]).map(fromApiAccount))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId, channelsKey, project])

  function handleUpdated(updated: Publication) {
    setPublications((current) => current.map((p) => (p.id === updated.id ? updated : p)))
  }

  const visible = publications.filter((p) => channels.includes(p.platform))

  return (
    <div className="flex flex-col gap-3">
      <span className="label-mono text-muted-foreground">{t.socialPublications.title}</span>
      {loading && <span className="label-mono text-muted-foreground">{t.socialPublications.loading}</span>}
      {!loading && visible.length === 0 && (
        <p className="text-sm text-muted-foreground">{t.socialPublications.empty}</p>
      )}
      {visible.map((p) => (
        <PublicationRow key={p.id} publication={p} accounts={accounts} project={project} onUpdated={handleUpdated} />
      ))}
    </div>
  )
}
