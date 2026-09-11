'use client'

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { SectionHeader, Metric, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { SocialPublications, type PublicationSummary } from '@/components/sections/social-publications'

const STATUSES = ['idea', 'draft', 'ready', 'published'] as const
const CHANNELS = ['telegram', 'instagram', 'threads', 'vk'] as const

type SocialStatus = (typeof STATUSES)[number]
type SocialChannel = (typeof CHANNELS)[number]

type SocialPost = {
  id: string
  topic: string
  body: string
  telegramText: string
  instagramText: string
  threadsText: string
  vkText: string
  channels: SocialChannel[]
  publishDate: string
  status: SocialStatus
  createdAt: string
}

function fromApiPost(row: Record<string, unknown>): SocialPost {
  const channels = typeof row.channels === 'string'
    ? row.channels.split(',').filter((c): c is SocialChannel => (CHANNELS as readonly string[]).includes(c))
    : []
  return {
    id: row.id as string,
    topic: row.topic as string,
    body: (row.body as string) ?? '',
    telegramText: (row.telegram_text as string) ?? '',
    instagramText: (row.instagram_text as string) ?? '',
    threadsText: (row.threads_text as string) ?? '',
    vkText: (row.vk_text as string) ?? '',
    channels,
    publishDate: (row.publish_date as string) ?? '',
    status: (row.status as SocialStatus) ?? 'idea',
    createdAt: row.created_at as string,
  }
}

/** A post has real per-channel overrides only if at least one channel field is non-empty and
 * differs from body once trimmed — an empty or body-identical field is just unused/fallback,
 * not an override. Drives whether "Different text per channel" opens automatically on edit. */
function hasDistinctChannelText(post: SocialPost): boolean {
  const body = post.body.trim()
  return [post.telegramText, post.instagramText, post.threadsText, post.vkText].some((text) => {
    const trimmed = text.trim()
    return trimmed !== '' && trimmed !== body
  })
}

function formatDate(value: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function PostDetail({
  post,
  onClose,
  onSaved,
  onDeleted,
  project,
}: {
  post: SocialPost
  onClose: () => void
  onSaved: (post: SocialPost) => void
  onDeleted: (id: string) => void
  project: string
}) {
  const { t, locale } = useI18n()
  const [topic, setTopic] = useState(post.topic)
  const [body, setBody] = useState(post.body)
  const [telegramText, setTelegramText] = useState(post.telegramText)
  const [instagramText, setInstagramText] = useState(post.instagramText)
  const [threadsText, setThreadsText] = useState(post.threadsText)
  const [vkText, setVkText] = useState(post.vkText)
  const [channels, setChannels] = useState<SocialChannel[]>(post.channels)
  const [publishDate, setPublishDate] = useState(post.publishDate)
  const [status, setStatus] = useState<SocialStatus>(post.status)
  const [differentPerChannel, setDifferentPerChannel] = useState(() => hasDistinctChannelText(post))
  const [publicationSummary, setPublicationSummary] = useState<PublicationSummary>('draft')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')

  useEffect(() => {
    setTopic(post.topic)
    setBody(post.body)
    setTelegramText(post.telegramText)
    setInstagramText(post.instagramText)
    setThreadsText(post.threadsText)
    setVkText(post.vkText)
    setChannels(post.channels)
    setPublishDate(post.publishDate)
    setStatus(post.status)
    setDifferentPerChannel(hasDistinctChannelText(post))
  }, [post])

  function toggleChannel(channel: SocialChannel) {
    setChannels((current) =>
      current.includes(channel) ? current.filter((c) => c !== channel) : [...current, channel],
    )
  }

  async function save(patch: Record<string, unknown>) {
    setSaving(true)
    try {
      const res = await fetch(`/api/social/${post.id}?project=${encodeURIComponent(project)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (res.ok) onSaved(fromApiPost(await res.json()))
    } finally {
      setSaving(false)
    }
  }

  /** Re-fetches the post so its Status reflects a server-side reconciliation against
   * social_publications (see syncPostStatusFromPublications) triggered by a publication change,
   * without requiring the user to close and reopen the post. */
  async function refreshPost() {
    const res = await fetch(`/api/social/${post.id}?project=${encodeURIComponent(project)}`)
    if (res.ok) onSaved(fromApiPost(await res.json()))
  }

  /** Asks the OLNOO AI Router (via /api/social/generate-variants) to adapt the current, possibly
   * unsaved, Content into per-channel text for the currently selected channels. Only fills the
   * fields the response actually returned and turns the toggle on — nothing is persisted until
   * the user clicks Save. A failure never touches existing field values; the button stays usable
   * to retry. */
  async function handleGenerateVariants() {
    setGenerating(true)
    setGenerateError('')
    try {
      const res = await fetch('/api/social/generate-variants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, topic, body, channels, locale }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        const message = data && typeof data.error === 'string' ? data.error : t.socialView.generateVariantsError
        throw new Error(message)
      }
      const variants = (data?.variants ?? {}) as Partial<Record<SocialChannel, string>>
      if (typeof variants.telegram === 'string') setTelegramText(variants.telegram)
      if (typeof variants.instagram === 'string') setInstagramText(variants.instagram)
      if (typeof variants.threads === 'string') setThreadsText(variants.threads)
      if (typeof variants.vk === 'string') setVkText(variants.vk)
      setDifferentPerChannel(true)
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : t.socialView.generateVariantsError)
    } finally {
      setGenerating(false)
    }
  }

  async function saveAll() {
    const patch: Record<string, unknown> = { topic, body, channels, publishDate }
    if (differentPerChannel) {
      patch.telegramText = telegramText
      patch.instagramText = instagramText
      patch.threadsText = threadsText
      patch.vkText = vkText
    } else {
      // Off means only the shared Content is used for the selected channels — explicitly clear
      // their per-channel overrides so old distinct text can't make the toggle re-derive to ON
      // after reload. body itself, and any field for a channel that isn't currently selected,
      // are left untouched.
      if (channels.includes('telegram')) patch.telegramText = ''
      if (channels.includes('instagram')) patch.instagramText = ''
      if (channels.includes('threads')) patch.threadsText = ''
      if (channels.includes('vk')) patch.vkText = ''
    }
    await save(patch)
  }

  async function handleDelete() {
    if (!window.confirm(t.socialView.confirmDelete.replace('{topic}', post.topic))) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/social/${post.id}?project=${encodeURIComponent(project)}`, { method: 'DELETE' })
      if (res.ok) {
        onDeleted(post.id)
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
          <span className="label-mono text-muted-foreground">{t.socialView.detailLabel}</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-6 px-6 py-6">
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">Topic</span>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.socialView.content}</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              className="resize-none border border-hairline bg-card p-3 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <div className="flex flex-col gap-3">
            <span className="label-mono text-muted-foreground">{t.socialView.channels}</span>
            {CHANNELS.map((channel) => (
              <label key={channel} className="flex items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={channels.includes(channel)}
                  onChange={() => toggleChannel(channel)}
                  className="size-4 accent-foreground"
                />
                {t.socialChannel[channel]}
              </label>
            ))}
          </div>

          {body.trim() !== '' && channels.length > 0 && (
            <div className="flex flex-col gap-2">
              <button
                onClick={handleGenerateVariants}
                disabled={generating}
                className="label-mono border border-hairline px-4 py-2.5 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
              >
                {generating ? t.socialView.generatingVariants : t.socialView.generateVariants}
              </button>
              {generateError && <p className="text-sm text-destructive">{generateError}</p>}
            </div>
          )}

          <label className="flex items-center justify-between gap-4 border border-hairline bg-card px-4 py-3">
            <span className="label-mono text-muted-foreground">{t.socialView.differentPerChannel}</span>
            <input
              type="checkbox"
              checked={differentPerChannel}
              onChange={(e) => setDifferentPerChannel(e.target.checked)}
              className="size-4 accent-foreground"
            />
          </label>

          {differentPerChannel && (
            <div className="flex flex-col gap-5">
              {channels.includes('telegram') && (
                <label className="flex flex-col gap-1.5">
                  <span className="label-mono text-muted-foreground">{t.socialChannel.telegram}</span>
                  <textarea
                    value={telegramText}
                    onChange={(e) => setTelegramText(e.target.value)}
                    rows={3}
                    className="resize-none border border-hairline bg-card p-3 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                  />
                </label>
              )}
              {channels.includes('instagram') && (
                <label className="flex flex-col gap-1.5">
                  <span className="label-mono text-muted-foreground">{t.socialChannel.instagram}</span>
                  <textarea
                    value={instagramText}
                    onChange={(e) => setInstagramText(e.target.value)}
                    rows={3}
                    className="resize-none border border-hairline bg-card p-3 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                  />
                </label>
              )}
              {channels.includes('threads') && (
                <label className="flex flex-col gap-1.5">
                  <span className="label-mono text-muted-foreground">{t.socialChannel.threads}</span>
                  <textarea
                    value={threadsText}
                    onChange={(e) => setThreadsText(e.target.value)}
                    rows={3}
                    className="resize-none border border-hairline bg-card p-3 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                  />
                </label>
              )}
              {channels.includes('vk') && (
                <label className="flex flex-col gap-1.5">
                  <span className="label-mono text-muted-foreground">{t.socialChannel.vk}</span>
                  <textarea
                    value={vkText}
                    onChange={(e) => setVkText(e.target.value)}
                    rows={3}
                    className="resize-none border border-hairline bg-card p-3 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                  />
                </label>
              )}
            </div>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.socialView.publishDate}</span>
            <input
              type="date"
              value={publishDate}
              onChange={(e) => setPublishDate(e.target.value)}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <label className="flex items-center justify-between gap-4 border border-hairline bg-card px-4 py-3">
            <span className="label-mono text-muted-foreground">{t.socialView.filterStatus}</span>
            <select
              value={status}
              onChange={(e) => {
                const next = e.target.value as SocialStatus
                setStatus(next)
                save({ status: next })
              }}
              className="label-mono bg-transparent text-right text-foreground focus:outline-none"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s} disabled={s === 'published' && publicationSummary !== 'fully_published'}>
                  {t.status[s]}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={saveAll}
            disabled={saving}
            className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
          >
            {saving ? t.common.saving : 'Save'}
          </button>

          <div className="border-t border-hairline pt-6">
            <SocialPublications
              postId={post.id}
              channels={post.channels}
              project={project}
              onPostChanged={refreshPost}
              onSummaryChange={setPublicationSummary}
            />
          </div>

          <div className="border-t border-hairline pt-6">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="label-mono border border-destructive/40 px-4 py-2.5 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {deleting ? t.common.deleting : t.socialView.deletePost}
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
  onCreated: (post: SocialPost) => void
}) {
  const { t } = useI18n()
  const [topic, setTopic] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, topic }),
      })
      if (!res.ok) throw new Error('failed')
      onCreated(fromApiPost(await res.json()))
      onClose()
    } catch {
      setError(t.socialView.createError)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-foreground/10" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 z-40 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
          <span className="label-mono text-muted-foreground">{t.socialView.addPost}</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-5 px-6 py-6">
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">Topic</span>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <button
            onClick={submit}
            disabled={saving || !topic.trim()}
            className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
          >
            {saving ? t.common.saving : t.socialView.addPost}
          </button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </aside>
    </>
  )
}

export function SocialView({ project }: { project: string }) {
  const { t } = useI18n()
  const [posts, setPosts] = useState<SocialPost[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<SocialPost | null>(null)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('All')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/social?project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((rows) => {
        if (cancelled) return
        setPosts((rows as Record<string, unknown>[]).map(fromApiPost))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project])

  const filtered = useMemo(() => {
    return posts.filter((p) => {
      const matchesQuery = !query || p.topic.toLowerCase().includes(query.toLowerCase())
      const matchesStatus = status === 'All' || p.status === status
      return matchesQuery && matchesStatus
    })
  }, [posts, query, status])

  const counts = useMemo(() => {
    const c: Record<SocialStatus, number> = { idea: 0, draft: 0, ready: 0, published: 0 }
    for (const p of posts) c[p.status]++
    return c
  }, [posts])

  function handleSaved(updated: SocialPost) {
    setPosts((current) => current.map((p) => (p.id === updated.id ? updated : p)))
    setSelected(updated)
  }

  function handleDeleted(id: string) {
    setPosts((current) => current.filter((p) => p.id !== id))
    setSelected(null)
  }

  function handleCreated(post: SocialPost) {
    setPosts((current) => [post, ...current])
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="01"
        title={t.socialView.title}
        description={t.socialView.description}
        action={
          <button
            onClick={() => setCreating(true)}
            className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground"
          >
            {t.socialView.addPost}
          </button>
        }
      />

      <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-4">
        <Metric label={t.status.idea} value={counts.idea} accent />
        <Metric label={t.status.draft} value={counts.draft} />
        <Metric label={t.status.ready} value={counts.ready} />
        <Metric label={t.status.published} value={counts.published} />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.socialView.searchPlaceholder}
          className="label-mono min-w-[200px] flex-1 border border-hairline bg-card px-4 py-2.5 text-foreground placeholder:text-muted-foreground focus:border-foreground/40 focus:outline-none"
        />
        <label className="flex items-center gap-2 border border-hairline bg-card px-3 py-2">
          <span className="label-mono text-muted-foreground">{t.socialView.filterStatus}</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
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
            <Th>Topic</Th>
            <Th>{t.socialView.channels}</Th>
            <Th>{t.socialView.filterStatus}</Th>
            <Th>{t.socialView.publishDate}</Th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr
              key={p.id}
              onClick={() => setSelected(p)}
              className="cursor-pointer transition-colors hover:bg-muted/60"
            >
              <Td className="font-medium text-foreground">{p.topic}</Td>
              <Td>
                <span className="label-mono text-muted-foreground">
                  {p.channels.map((c) => t.socialChannel[c]).join(', ') || '—'}
                </span>
              </Td>
              <Td>
                <StatusPill status={p.status} />
              </Td>
              <Td className="font-mono text-xs text-muted-foreground">{formatDate(p.publishDate)}</Td>
            </tr>
          ))}
          {!loading && filtered.length === 0 && (
            <tr>
              <Td className="text-muted-foreground">
                <span className="label-mono">{t.socialView.noResults}</span>
              </Td>
              <Td> </Td>
              <Td> </Td>
              <Td> </Td>
            </tr>
          )}
        </tbody>
      </TableShell>

      {selected && (
        <PostDetail
          post={selected}
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
