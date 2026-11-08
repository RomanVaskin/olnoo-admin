'use client'

import { useEffect, useRef, useState } from 'react'
import { SectionHeader, HeaderActions, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { ProjectSelector } from '@/components/project-selector'
import { useI18n } from '@/components/i18n-provider'

// Only currently offered source types; existing website/youtube sources remain visible.
// Keep this local to avoid pulling server-only source registry into the client bundle.
const SOURCE_TYPES = ['telegram', 'rss'] as const
type SourceType = 'telegram' | 'rss' | 'website' | 'youtube'

type Source = {
  id: string
  type: SourceType
  handle: string
  enabled: boolean
  processingMode: 'ai' | 'copy'
  copyPermissionConfirmed: boolean
  automation?: AutomationPolicy
  automationRevision?: string
  automationRuntime?: { operation?: string; error?: string; checkedAt?: string; paused?: boolean }
  duplicateCount?: number
  lastCheckedAt: string | null
  lastError: string
}

const operationLabels: Record<string, string> = { baseline: 'Начальная граница сохранена', collected: 'Материалы собраны', waiting: 'Ожидание новых данных', processing: 'Подготовка', pending: 'В очереди', review: 'Требуется согласование', publishing: 'Отправка', published: 'Опубликовано', uncertain: 'Результат отправки неизвестен', paused: 'Автоматизация остановлена', error: 'Ошибка операции', ai_limit: 'Достигнут лимит AI', daily_limit: 'Достигнут лимит отправок', send_retry: 'Ожидание повторной отправки' }

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

export function ContentFactorySourcesView({
  project,
  onProjectChange,
}: {
  project: string
  onProjectChange: (id: string) => void
}) {
  const { t } = useI18n()
  const [sources, setSources] = useState<Source[]>([])
  const [accounts, setAccounts] = useState<TelegramAccount[]>([])
  const [operationError, setOperationError] = useState('')
  const currentProject = useRef(project)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [newType, setNewType] = useState<SourceType>('telegram')
  const [newHandle, setNewHandle] = useState('')
  const [newMode, setNewMode] = useState<'ai' | 'copy'>('ai')
  const [newCopyPermission, setNewCopyPermission] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [checkMessage, setCheckMessage] = useState<Record<string, string>>({})

  async function load() {
    if (project === 'all') {
      setSources([])
      return
    }
    setLoading(true); setOperationError('')
    try {
      const res = await fetch(`/api/content-factory/sources?project=${encodeURIComponent(project)}`)
      if (res.ok) { const rows = await res.json(); if (currentProject.current !== project) return; setSources(rows) }
      else throw new Error((await res.json().catch(() => null))?.error || 'Не удалось загрузить источники. Проверьте миграцию 0043.')
      const acc = await fetch(`/api/social-accounts?project=${encodeURIComponent(project)}`)
      if (acc.ok) { const rows = await acc.json() as TelegramAccount[]; if (currentProject.current !== project) return; setAccounts(rows.filter((a) => a.platform === 'telegram' && a.active && a.status === 'connected')) }
      else { setAccounts([]); setOperationError('Не удалось загрузить каналы назначения.') }
    } catch (e) { setOperationError(e instanceof Error ? e.message : 'Ошибка загрузки.') } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    currentProject.current = project
    setSources([]); setAccounts([])
    load()
    setCheckMessage({})
  }, [project])

  async function addSource() {
    if (!newHandle.trim()) return
    setCreating(true)
    setCreateError('')
    try {
      const res = await fetch(`/api/content-factory/sources?project=${encodeURIComponent(project)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: newType, handle: newHandle, processingMode: newMode, copyPermissionConfirmed: newCopyPermission }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error((data && data.error) || t.contentFactory.sources.createError)
      setNewHandle('')
      setNewMode('ai')
      setNewCopyPermission(false)
      await load()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t.contentFactory.sources.createError)
    } finally {
      setCreating(false)
    }
  }

  async function toggleEnabled(source: Source) {
    const res = await fetch(`/api/content-factory/sources/${source.id}?project=${encodeURIComponent(project)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !source.enabled }),
    })
    if (res.ok) await load()
    else setOperationError((await res.json().catch(() => null))?.error || 'Не удалось изменить источник.')
  }

  async function changeMode(source: Source, mode: 'ai' | 'copy') {
    if (mode === 'copy' && !window.confirm('Партнёр разрешил копирование своих материалов?')) return
    const res = await fetch(`/api/content-factory/sources/${source.id}?project=${encodeURIComponent(project)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ processingMode: mode, copyPermissionConfirmed: mode === 'copy' }),
    })
    if (res.ok) await load()
    else setOperationError((await res.json().catch(() => null))?.error || 'Не удалось изменить источник.')
  }

  async function remove(source: Source) {
    if (!window.confirm(t.contentFactory.sources.confirmDelete)) return
    const res = await fetch(`/api/content-factory/sources/${source.id}?project=${encodeURIComponent(project)}`, { method: 'DELETE' })
    if (res.ok) await load()
    else setOperationError((await res.json().catch(() => null))?.error || 'Не удалось изменить источник.')
  }

  async function checkNow(source: Source) {
    setCheckingId(source.id)
    try {
      const res = await fetch(`/api/content-factory/sources/${source.id}/check?project=${encodeURIComponent(project)}`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (res.ok) {
        const message = data?.error
          ? data.error
          : t.contentFactory.sources.checkResult.replace('{count}', String(data?.createdCount ?? 0))
        setCheckMessage((m) => ({ ...m, [source.id]: message }))
      }
      await load()
    } finally {
      setCheckingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="02"
        title={t.contentFactory.sources.title}
        description={t.contentFactory.sources.description}
        action={<ProjectSelector value={project} onChange={onProjectChange} />}
      />

      {project === 'all' ? (
        <p className="text-sm text-muted-foreground">{t.contentFactory.selectProjectHint}</p>
      ) : (
        <>
          <MonitorConnection key={project} project={project} />
          <HeaderActions>
            <select
              value={newType}
              onChange={(e) => { setNewType(e.target.value as SourceType); setNewMode('ai'); setNewCopyPermission(false) }}
              className="border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            >
              {SOURCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t.contentFactory.sourceType[type]}
                </option>
              ))}
            </select>
            <input
              value={newHandle}
              onChange={(e) => setNewHandle(e.target.value)}
              placeholder={newType === 'rss' ? 'https://example.com/news/feed.xml' : t.contentFactory.sources.handlePlaceholder}
              className="min-w-[220px] border border-hairline bg-card px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            />
            <select value={newMode} onChange={(e) => { setNewMode(e.target.value as 'ai' | 'copy'); setNewCopyPermission(false) }} className="border border-hairline bg-card px-3 py-2.5 text-sm">
              <option value="ai">{t.contentFactory.sources.modeAi}</option>
              <option value="copy" disabled={newType !== 'telegram'}>{t.contentFactory.sources.modeCopy}</option>
            </select>
            {newMode === 'copy' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={newCopyPermission} onChange={(e) => setNewCopyPermission(e.target.checked)} />Есть разрешение партнёра на копирование материалов</label>}
            <button
              onClick={addSource}
              disabled={creating || !newHandle.trim() || (newMode === 'copy' && !newCopyPermission)}
              className="label-mono flex items-center justify-center border border-foreground bg-foreground px-4 py-2 text-background transition-colors hover:bg-transparent hover:text-foreground disabled:opacity-50"
            >
              {t.contentFactory.sources.addSource}
            </button>
          </HeaderActions>
          {operationError && <p role="alert" className="text-sm text-destructive">{operationError}</p>}
          {createError && <p className="text-sm text-destructive">{createError}</p>}

          <TableShell>
            <thead>
              <tr>
                <Th>{t.contentFactory.sources.tableSource}</Th>
                <Th>{t.contentFactory.sources.tableType}</Th>
                <Th>{t.contentFactory.sources.tableStatus}</Th>
                <Th>{t.contentFactory.sources.tableLastChecked}</Th>
                <Th>Автоматизация · каждые 10 минут</Th>
                <Th>{t.table.actions}</Th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <Td className="font-medium text-foreground">{source.handle}{!!source.duplicateCount && <p className="mt-1 text-xs text-destructive">Дубликатов в проекте: {source.duplicateCount}. Отключите лишние строки; историю не удаляйте.</p>}</Td>
                  <Td>
                    <span className="label-mono text-muted-foreground">{t.contentFactory.sourceType[source.type]}</span>
                    <select value={source.processingMode} onChange={(e) => changeMode(source, e.target.value as 'ai' | 'copy')} className="mt-1 block border border-hairline bg-card p-1 text-xs">
                      <option value="ai">{t.contentFactory.sources.modeAi}</option>
                      <option value="copy" disabled={source.type !== 'telegram'}>{t.contentFactory.sources.modeCopy}</option>
                    </select>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <StatusPill status={source.enabled ? 'active' : 'paused'} />
                      {source.lastError && (
                        <span className="text-xs text-destructive">
                          {t.contentFactory.sources.lastErrorPrefix}
                          {source.lastError}
                        </span>
                      )}
                      {checkMessage[source.id] && <span className="text-xs text-muted-foreground">{checkMessage[source.id]}</span>}
                    </div>
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(source.lastCheckedAt)}</Td>
                  <Td>
                    <SourceAutomationEditor key={`${source.id}:${source.automationRevision}`} source={source} project={project} accounts={accounts} onSaved={load} />
                    {source.automationRuntime?.operation && <p className="mt-2 text-xs">{operationLabels[source.automationRuntime.operation] ?? 'Проверка'} · {formatDate(source.automationRuntime.checkedAt ?? null)}</p>}
                    {source.automationRuntime?.error && <p className="text-xs text-destructive">{source.automationRuntime.error}</p>}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => checkNow(source)}
                        disabled={checkingId === source.id}
                        className="label-mono border border-hairline px-2.5 py-1.5 text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                      >
                        {checkingId === source.id ? t.contentFactory.sources.checking : t.contentFactory.sources.actionCheckNow}
                      </button>
                      <button
                        onClick={() => toggleEnabled(source)}
                        className="label-mono border border-hairline px-2.5 py-1.5 text-foreground transition-colors hover:bg-muted/60"
                      >
                        {source.enabled ? t.contentFactory.sources.actionDisable : t.contentFactory.sources.actionEnable}
                      </button>
                      <button
                        onClick={() => remove(source)}
                        className="label-mono border border-hairline px-2.5 py-1.5 text-destructive transition-colors hover:bg-muted/60"
                      >
                        {t.contentFactory.sources.actionDelete}
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
              {!loading && sources.length === 0 && (
                <tr>
                  <Td className="text-muted-foreground">
                    <span className="label-mono">{t.contentFactory.sources.noResults}</span>
                  </Td>
                  <Td> </Td>
                  <Td> </Td>
                  <Td> </Td>
                  <Td> </Td>
                </tr>
              )}
            </tbody>
          </TableShell>
        </>
      )}
    </div>
  )
}

type AutomationPolicy = { transport?: 'preview' | 'monitor'; mode: 'manual' | 'auto_review' | 'auto_publish'; accountId: string | null; dailyLimit: number; mediaRightsConfirmed: boolean }
type TelegramAccount = { id: string; platform: string; name: string; username: string; active: boolean; status: string }
function SourceAutomationEditor({ source, project, accounts, onSaved }: { source: Source; project: string; accounts: TelegramAccount[]; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<AutomationPolicy>(source.automation ?? { mode: 'manual', accountId: null, dailyLimit: 3, mediaRightsConfirmed: false })
  const [handle, setHandle] = useState(source.handle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const modes = { manual: 'Ручной', auto_review: 'С согласованием', auto_publish: source.processingMode === 'copy' && source.automation?.transport !== 'monitor' ? 'Автоматический: копия требует согласования' : 'Автоматический' }
  return <details className="min-w-[210px] text-xs">
    <summary className="cursor-pointer">{modes[source.automation?.mode ?? 'manual']} · {accounts.find((a) => a.id === source.automation?.accountId)?.username ?? 'Канал не выбран'} · {source.automation?.dailyLimit ?? 3}/сутки</summary>
    <div className="mt-2 flex flex-col gap-2">
      <label>Получение<select aria-label={`Получение ${source.handle}`} value={draft.transport ?? 'preview'} disabled={busy || source.type !== 'telegram'} onChange={(e) => setDraft({ ...draft, transport: e.target.value as 'preview' | 'monitor' })} className="block w-full border border-hairline bg-card p-1"><option value="preview">HTML-превью — ручная проверка</option><option value="monitor">OLNOO Monitor — Telegram Client API</option></select></label>
      <label>Адрес источника<input aria-label={`Адрес источника ${source.handle}`} value={handle} disabled={busy} onChange={(e) => setHandle(e.target.value)} className="block w-full border border-hairline bg-card p-1" /></label>
      <label>Режим публикации<select aria-label={`Режим публикации ${source.handle}`} value={draft.mode} disabled={busy || source.type !== 'telegram'} onChange={(e) => setDraft({ ...draft, mode: e.target.value as AutomationPolicy['mode'] })} className="block w-full border border-hairline bg-card p-1">{Object.entries(modes).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Канал назначения<select aria-label={`Канал назначения ${source.handle}`} disabled={busy} value={draft.accountId ?? ''} onChange={(e) => setDraft({ ...draft, accountId: e.target.value || null })} className="block w-full border border-hairline bg-card p-1"><option value="">Выберите канал</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} {a.username}</option>)}</select></label>
      {!accounts.length && <span role="alert">Нет подключённых Telegram-каналов. Подключите канал в «Соцсетях».</span>}
      <label>Лимит в сутки<input aria-label={`Лимит в сутки ${source.handle}`} type="number" min={1} max={20} value={draft.dailyLimit} disabled={busy} onChange={(e) => setDraft({ ...draft, dailyLimit: Number(e.target.value) })} className="block w-full border border-hairline bg-card p-1" /></label>
      <span>Проверка каждые 10 минут. При включении старый архив не публикуется.</span>
      {source.processingMode === 'copy' && source.automation?.transport !== 'monitor' && <>
        <label className="flex items-start gap-1"><input type="checkbox" checked={draft.mediaRightsConfirmed} disabled={busy} onChange={(e) => setDraft({ ...draft, mediaRightsConfirmed: e.target.checked })} />Разрешение правообладателя распространяется на изображения.</label>
        <span>HTML-превью не подтверждает полноту оригинала/альбома. Копии требуют сравнения и ручного утверждения даже в автоматическом режиме.</span>
      </>}
      <button type="button" disabled={busy || (draft.mode !== 'manual' && !draft.accountId)} className="border border-hairline p-1 disabled:opacity-50" onClick={async () => {
        if (busy) return
        setBusy(true); setError('')
        try {
          const res = await fetch(`/api/content-factory/sources/${source.id}?project=${encodeURIComponent(project)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ automation: draft, handle }) })
          const data = await res.json().catch(() => null)
          if (!res.ok) throw new Error(data?.error || 'Не удалось сохранить настройки.')
          await onSaved()
        } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка сохранения.') }
        finally { setBusy(false) }
      }}>{busy ? 'Сохранение…' : 'Сохранить настройки'}</button>
      {error && <span role="alert" className="text-destructive">{error}</span>}
    </div>
  </details>
}

function MonitorConnection({project}:{project:string}) {
  const [status,setStatus]=useState('Не проверено'),[busy,setBusy]=useState(false)
  async function check(){setBusy(true);try{const response=await fetch(`/api/content-factory/monitor?project=${encodeURIComponent(project)}`,{method:'POST'});const result=await response.json();setStatus(response.ok&&result.status==='connected'?'Подключён':result.error==='AUTHORIZATION_REQUIRED'?'Требуется первичная авторизация на сервере':result.error==='NOT_CONFIGURED'?'Не настроен':result.error==='BUSY'?'Выполняется проверка источника':result.error==='FLOOD_WAIT'?'Telegram временно ограничил запросы':'Соединение недоступно')}catch{setStatus('Не удалось проверить соединение')}finally{setBusy(false)}}
  return <div className="flex flex-wrap items-center gap-3 border border-hairline p-3 text-sm"><span role="status">OLNOO Monitor: {status}</span><button type="button" disabled={busy} onClick={check} className="border border-hairline px-3 py-1 disabled:opacity-50">{busy?'Проверка…':'Проверить / переподключить'}</button></div>
}
