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

export type PublicationSummary = 'fully_published' | 'partially_published' | 'ready' | 'draft'

/** The single source of truth for "is this post published" — computed fresh from
 * social_publications every time, never stored, so it can't drift from reality. A channel with
 * no publication row yet counts the same as one that isn't published. */
export function summarizePublications(channels: string[], publications: Publication[]): PublicationSummary {
  if (channels.length === 0) return 'draft'
  const relevant = channels.map((channel) => publications.find((p) => p.platform === channel))
  if (relevant.every((p) => p?.status === 'published')) return 'fully_published'
  if (relevant.some((p) => p?.status === 'published')) return 'partially_published'
  if (relevant.some((p) => p?.status === 'ready')) return 'ready'
  return 'draft'
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

function SummaryBadge({ summary }: { summary: PublicationSummary }) {
  const { t } = useI18n()
  const label =
    summary === 'fully_published'
      ? t.socialPublications.fullyPublished
      : summary === 'partially_published'
        ? t.socialPublications.partiallyPublished
        : summary === 'ready'
          ? t.status.ready
          : t.status.draft
  const dotClass = summary === 'fully_published' ? 'bg-blue' : 'bg-muted-foreground'

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className={`size-1.5 rounded-full ${dotClass}`} aria-hidden />
      <span className="label-mono text-foreground/80">{label}</span>
    </span>
  )
}

export function SocialPublications({
  postId,
  channels,
  project,
  onPostChanged,
  onSummaryChange,
}: {
  postId: string
  channels: string[]
  project: string
  /** Called after a publication update, since the post's own status may have just been
   * reconciled server-side (see syncPostStatusFromPublications) — lets the parent refetch the
   * post so its Status field reflects that without waiting for a manual reload. */
  onPostChanged?: () => void
  /** Reports the live fully/partially-published/ready/draft summary so the parent can gate
   * manual selection of the post's own "Published" status against it. */
  onSummaryChange?: (summary: PublicationSummary) => void
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
    onPostChanged?.()
  }

  const visible = publications.filter((p) => channels.includes(p.platform))
  const summary = summarizePublications(channels, publications)

  useEffect(() => {
    if (!loading) onSummaryChange?.(summary)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, loading])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="label-mono text-muted-foreground">{t.socialPublications.title}</span>
        {!loading && <SummaryBadge summary={summary} />}
      </div>
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
