'use client'

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { SectionHeader, HeaderActions, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'

const PLATFORMS = ['telegram', 'instagram', 'threads', 'vk'] as const
const STATUSES = ['created', 'connected', 'error'] as const

type SocialPlatform = (typeof PLATFORMS)[number]
type SocialAccountStatus = (typeof STATUSES)[number]

type SocialAccount = {
  id: string
  platform: SocialPlatform
  name: string
  username: string
  publicUrl: string
  status: SocialAccountStatus
  active: boolean
  notes: string
  createdAt: string
  // VK only — never the token itself (the API never returns it). vkGroupId is set once a token has
  // been verified at least once; its presence is how the UI knows a VK connection already exists
  // without needing to see the secret.
  vkGroupId: string
  connectionError: string
}

function fromApiAccount(row: Record<string, unknown>): SocialAccount {
  return {
    id: row.id as string,
    platform: row.platform as SocialPlatform,
    name: (row.name as string) ?? '',
    username: (row.username as string) ?? '',
    publicUrl: (row.public_url as string) ?? '',
    status: (row.status as SocialAccountStatus) ?? 'created',
    active: (row.active as boolean) ?? true,
    notes: (row.notes as string) ?? '',
    createdAt: row.created_at as string,
    vkGroupId: (row.vk_group_id as string) ?? '',
    connectionError: (row.connection_error as string) ?? '',
  }
}

function AccountDetail({
  account,
  onClose,
  onSaved,
  onDeleted,
  project,
}: {
  account: SocialAccount
  onClose: () => void
  onSaved: (account: SocialAccount) => void
  onDeleted: (id: string) => void
  project: string
}) {
  const { t } = useI18n()
  const [platform, setPlatform] = useState(account.platform)
  const [name, setName] = useState(account.name)
  const [username, setUsername] = useState(account.username)
  const [publicUrl, setPublicUrl] = useState(account.publicUrl)
  const [status, setStatus] = useState(account.status)
  const [active, setActive] = useState(account.active)
  const [notes, setNotes] = useState(account.notes)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [vkToken, setVkToken] = useState('')
  const [vkConnecting, setVkConnecting] = useState(false)
  const [vkConnectError, setVkConnectError] = useState('')
  const [telegramConnecting, setTelegramConnecting] = useState(false)
  const [telegramConnectError, setTelegramConnectError] = useState('')

  useEffect(() => {
    setPlatform(account.platform)
    setName(account.name)
    setUsername(account.username)
    setPublicUrl(account.publicUrl)
    setStatus(account.status)
    setActive(account.active)
    setNotes(account.notes)
    setVkToken('')
    setVkConnectError('')
    setTelegramConnectError('')
  }, [account])

  async function save(patch: Record<string, unknown>) {
    setSaving(true)
    try {
      const res = await fetch(`/api/social-accounts/${account.id}?project=${encodeURIComponent(project)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (res.ok) onSaved(fromApiAccount(await res.json()))
    } finally {
      setSaving(false)
    }
  }

  async function saveAll() {
    // Telegram's username (the channel chat_id/handle) only ever changes through
    // connectTelegram, which verifies the bot can post there first — the server now rejects a
    // plain PATCH that tries to change it (lib/social-accounts.ts), so it's left out here to
    // avoid a silently-failing save on blur. Every other platform is unaffected.
    if (platform === 'telegram') {
      await save({ name, publicUrl, notes })
      return
    }
    await save({ name, username, publicUrl, notes })
  }

  async function connectVk(token: string | null) {
    setVkConnecting(true)
    setVkConnectError('')
    try {
      const res = await fetch(`/api/social-accounts/${account.id}/vk-connection?project=${encodeURIComponent(project)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(token ? { accessToken: token } : {}),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setVkConnectError((data && typeof data.error === 'string' && data.error) || t.socialAccountsView.createError)
        return
      }
      const updated = fromApiAccount(data)
      onSaved(updated)
      setVkToken('')
      if (updated.status === 'error') setVkConnectError(updated.connectionError)
    } finally {
      setVkConnecting(false)
    }
  }

  async function connectTelegram(usernameOverride: string | null) {
    setTelegramConnecting(true)
    setTelegramConnectError('')
    try {
      const res = await fetch(`/api/social-accounts/${account.id}/telegram-connection?project=${encodeURIComponent(project)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(usernameOverride ? { username: usernameOverride } : {}),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setTelegramConnectError((data && typeof data.error === 'string' && data.error) || t.socialAccountsView.createError)
        return
      }
      const updated = fromApiAccount(data)
      onSaved(updated)
      if (updated.status === 'error') setTelegramConnectError(updated.connectionError)
    } finally {
      setTelegramConnecting(false)
    }
  }

  async function handleDelete() {
    if (!window.confirm(t.socialAccountsView.confirmDelete.replace('{name}', account.name || account.username || account.id)))
      return
    setDeleting(true)
    try {
      const res = await fetch(`/api/social-accounts/${account.id}?project=${encodeURIComponent(project)}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        onDeleted(account.id)
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
          <span className="label-mono text-muted-foreground">{t.socialAccountsView.detailLabel}</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-6 px-6 py-6">
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.socialAccountsView.platform}</span>
            <select
              value={platform}
              onChange={(e) => {
                const next = e.target.value as SocialPlatform
                setPlatform(next)
                save({ platform: next })
              }}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {t.socialChannel[p]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.socialAccountsView.name}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveAll}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.socialAccountsView.username}</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onBlur={saveAll}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.socialAccountsView.publicUrl}</span>
            <input
              value={publicUrl}
              onChange={(e) => setPublicUrl(e.target.value)}
              onBlur={saveAll}
              placeholder="https://…"
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          {platform === 'vk' && account.publicUrl && (
            <a
              href={account.publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="label-mono border border-hairline px-4 py-2.5 text-center text-foreground transition-colors hover:bg-muted/60"
            >
              {t.socialAccountsView.openInVk}
            </a>
          )}

          {platform === 'vk' && (
            <div className="flex flex-col gap-3 border border-hairline bg-card p-4">
              <span className="label-mono text-muted-foreground">{t.socialAccountsView.vkConnection}</span>
              <div className="flex items-center gap-2">
                <span className={`size-1.5 rounded-full ${account.status === 'connected' ? 'bg-blue' : account.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground'}`} aria-hidden />
                <span className="text-sm text-foreground/80">
                  {account.status === 'connected' ? t.socialAccountsView.vkConnected : t.socialAccountsView.vkNotConnected}
                </span>
              </div>
              {account.connectionError && <p className="text-sm text-destructive">{account.connectionError}</p>}
              <input
                type="password"
                value={vkToken}
                onChange={(e) => setVkToken(e.target.value)}
                placeholder={account.vkGroupId ? t.socialAccountsView.vkTokenPlaceholderSet : t.socialAccountsView.vkTokenPlaceholderUnset}
                className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => connectVk(vkToken)}
                  disabled={vkConnecting || !vkToken.trim()}
                  className="label-mono flex-1 border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
                >
                  {vkConnecting ? t.socialAccountsView.vkConnecting : t.socialAccountsView.vkConnect}
                </button>
                {account.vkGroupId && (
                  <button
                    onClick={() => connectVk(null)}
                    disabled={vkConnecting}
                    className="label-mono flex-1 border border-hairline px-4 py-2.5 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                  >
                    {vkConnecting ? t.socialAccountsView.vkConnecting : t.socialAccountsView.vkRecheck}
                  </button>
                )}
              </div>
              {vkConnectError && <p className="text-sm text-destructive">{vkConnectError}</p>}
            </div>
          )}

          {platform === 'telegram' && account.publicUrl && (
            <a
              href={account.publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="label-mono border border-hairline px-4 py-2.5 text-center text-foreground transition-colors hover:bg-muted/60"
            >
              {t.socialAccountsView.openInTelegram}
            </a>
          )}

          {platform === 'telegram' && (
            <div className="flex flex-col gap-3 border border-hairline bg-card p-4">
              <span className="label-mono text-muted-foreground">{t.socialAccountsView.telegramConnection}</span>
              <div className="flex items-center gap-2">
                <span className={`size-1.5 rounded-full ${account.status === 'connected' ? 'bg-blue' : account.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground'}`} aria-hidden />
                <span className="text-sm text-foreground/80">
                  {account.status === 'connected' ? t.socialAccountsView.telegramConnected : t.socialAccountsView.telegramNotConnected}
                </span>
              </div>
              {account.connectionError && <p className="text-sm text-destructive">{account.connectionError}</p>}
              <p className="text-sm text-muted-foreground">{t.socialAccountsView.telegramUsernameHint}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => connectTelegram(username)}
                  disabled={telegramConnecting || !username.trim()}
                  className="label-mono flex-1 border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
                >
                  {telegramConnecting ? t.socialAccountsView.telegramConnecting : t.socialAccountsView.telegramConnect}
                </button>
                {account.status !== 'created' && (
                  <button
                    onClick={() => connectTelegram(null)}
                    disabled={telegramConnecting}
                    className="label-mono flex-1 border border-hairline px-4 py-2.5 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                  >
                    {telegramConnecting ? t.socialAccountsView.telegramConnecting : t.socialAccountsView.telegramRecheck}
                  </button>
                )}
              </div>
              {telegramConnectError && <p className="text-sm text-destructive">{telegramConnectError}</p>}
            </div>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.socialAccountsView.notes}</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={saveAll}
              rows={3}
              className="resize-none border border-hairline bg-card p-3 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <label className="flex items-center justify-between gap-4 border border-hairline bg-card px-4 py-3">
            <span className="label-mono text-muted-foreground">{t.field.status}</span>
            <select
              value={status}
              onChange={(e) => {
                const next = e.target.value as SocialAccountStatus
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

          <label className="flex items-center justify-between gap-4 border border-hairline bg-card px-4 py-3">
            <span className="label-mono text-muted-foreground">{t.socialAccountsView.active}</span>
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => {
                const next = e.target.checked
                setActive(next)
                save({ active: next })
              }}
              className="size-4 accent-foreground"
            />
          </label>

          {saving && <span className="label-mono text-muted-foreground">{t.common.saving}</span>}

          <div className="border-t border-hairline pt-6">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="label-mono border border-destructive/40 px-4 py-2.5 text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {deleting ? t.common.deleting : t.socialAccountsView.deleteAccount}
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
  onCreated: (account: SocialAccount) => void
}) {
  const { t } = useI18n()
  const [platform, setPlatform] = useState<SocialPlatform>('telegram')
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/social-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, platform, name, username }),
      })
      if (!res.ok) throw new Error('failed')
      onCreated(fromApiAccount(await res.json()))
      onClose()
    } catch {
      setError(t.socialAccountsView.createError)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-foreground/10" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 z-40 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-5">
          <span className="label-mono text-muted-foreground">{t.socialAccountsView.addAccount}</span>
          <button
            onClick={onClose}
            className="label-mono flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.common.close} <X className="size-3" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-5 px-6 py-6">
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.socialAccountsView.platform}</span>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as SocialPlatform)}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {t.socialChannel[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.socialAccountsView.name}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label-mono text-muted-foreground">{t.socialAccountsView.username}</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
          </label>

          <button
            onClick={submit}
            disabled={saving}
            className="label-mono border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
          >
            {saving ? t.common.saving : t.socialAccountsView.addAccount}
          </button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </aside>
    </>
  )
}

export function SocialAccountsView({
  project,
  onProjectChange,
}: {
  project: string
  onProjectChange: (id: string) => void
}) {
  const { t } = useI18n()
  const [accounts, setAccounts] = useState<SocialAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<SocialAccount | null>(null)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [platformFilter, setPlatformFilter] = useState<string>('All')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/social-accounts?project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((rows) => {
        if (cancelled) return
        setAccounts((rows as Record<string, unknown>[]).map(fromApiAccount))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project])

  const filtered = useMemo(() => {
    return accounts.filter((a) => {
      const matchesQuery =
        !query ||
        a.name.toLowerCase().includes(query.toLowerCase()) ||
        a.username.toLowerCase().includes(query.toLowerCase())
      const matchesPlatform = platformFilter === 'All' || a.platform === platformFilter
      return matchesQuery && matchesPlatform
    })
  }, [accounts, query, platformFilter])

  function handleSaved(updated: SocialAccount) {
    setAccounts((current) => current.map((a) => (a.id === updated.id ? updated : a)))
    setSelected(updated)
  }

  function handleDeleted(id: string) {
    setAccounts((current) => current.filter((a) => a.id !== id))
    setSelected(null)
  }

  function handleCreated(account: SocialAccount) {
    setAccounts((current) => [account, ...current])
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="03"
        title={t.socialAccountsView.title}
        description={t.socialAccountsView.description}
        action={
          <HeaderActions>
            <ProjectSelector value={project} onChange={onProjectChange} />
            <button
              onClick={() => setCreating(true)}
              className="label-mono flex items-center justify-center border border-foreground bg-foreground px-4 py-2.5 text-background transition-colors hover:bg-transparent hover:text-foreground"
            >
              {t.socialAccountsView.addAccount}
            </button>
          </HeaderActions>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.socialAccountsView.searchPlaceholder}
          className="label-mono min-w-[200px] flex-1 border border-hairline bg-card px-4 py-2.5 text-foreground placeholder:text-muted-foreground focus:border-foreground/40 focus:outline-none"
        />
        <label className="flex items-center gap-2 border border-hairline bg-card px-3 py-2">
          <span className="label-mono text-muted-foreground">{t.socialAccountsView.platform}</span>
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            className="label-mono bg-transparent text-foreground focus:outline-none"
          >
            <option value="All">{t.common.all}</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {t.socialChannel[p]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <TableShell>
        <thead>
          <tr>
            <Th>{t.socialAccountsView.platform}</Th>
            <Th>{t.socialAccountsView.name}</Th>
            <Th>{t.socialAccountsView.username}</Th>
            <Th>{t.field.status}</Th>
            <Th>{t.socialAccountsView.active}</Th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((a) => (
            <tr
              key={a.id}
              onClick={() => setSelected(a)}
              className="cursor-pointer transition-colors hover:bg-muted/60"
            >
              <Td>
                <span className="label-mono text-muted-foreground">{t.socialChannel[a.platform]}</span>
              </Td>
              <Td className="font-medium text-foreground">{a.name || '—'}</Td>
              <Td className="text-muted-foreground">{a.username || '—'}</Td>
              <Td>
                <StatusPill status={a.status} />
              </Td>
              <Td className="text-muted-foreground">{a.active ? t.common.active : '—'}</Td>
            </tr>
          ))}
          {!loading && filtered.length === 0 && (
            <tr>
              <Td className="text-muted-foreground">
                <span className="label-mono">{t.socialAccountsView.noResults}</span>
              </Td>
              <Td> </Td>
              <Td> </Td>
              <Td> </Td>
              <Td> </Td>
            </tr>
          )}
        </tbody>
      </TableShell>

      {selected && (
        <AccountDetail
          account={selected}
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
