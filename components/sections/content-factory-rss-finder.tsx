'use client'
import { useState } from 'react'
import { TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'

type Result = { name: string; url: string; topics: string; language: string; status: 'verified' }
export function ContentFactoryRssFinder({ project, onConnected }: { project: string; onConnected: () => Promise<void> }) {
  const { locale } = useI18n()
  const label = (ru: string, en: string) => locale === 'ru' ? ru : en
  const [open, setOpen] = useState(false)
  const [country, setCountry] = useState('')
  const [topics, setTopics] = useState('')
  const [language, setLanguage] = useState('')
  const [results, setResults] = useState<Result[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(url?: string) {
    setBusy(true); setError('')
    if (!url) setResults(null)
    try {
      const res = await fetch(`/api/content-factory/sources/discover?project=${encodeURIComponent(project)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ country, topics, language, action: url ? 'connect' : 'search', url }) })
      const data = await res.json()
      if (!res.ok) {
        if (url && res.status === 409) setResults((items) => items?.filter((item) => item.url !== url) ?? null)
        throw new Error(data.error || label('Ошибка поиска RSS.', 'RSS search failed.'))
      }
      if (url) { setResults((items) => items?.filter((item) => item.url !== url) ?? null); await onConnected() }
      else setResults(data.results)
    } catch (err) { setError(err instanceof Error ? err.message : label('Ошибка запроса.', 'Request failed.')) }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-4">
    <button type="button" onClick={() => setOpen(!open)} className="label-mono self-start border border-hairline px-4 py-2">{label('Найти RSS', 'Find RSS')}</button>
    {open && <div className="flex flex-col gap-4 border border-hairline bg-card p-4">
      <div className="flex flex-wrap gap-3">
        {([[country, setCountry, label('Страна', 'Country')], [topics, setTopics, label('Темы', 'Topics')], [language, setLanguage, label('Язык', 'Language')]] as const).map(([value, setter, title]) => <label key={title} className="flex flex-col gap-1 text-sm">{title}<input value={value} onChange={(e) => setter(e.target.value)} maxLength={160} disabled={busy} className="border border-hairline bg-card px-3 py-2" /></label>)}
        <button type="button" onClick={() => run()} disabled={busy || !country.trim() || !topics.trim() || !language.trim()} className="label-mono self-end border border-foreground px-4 py-2 disabled:opacity-50">{busy ? label('Проверка…', 'Checking…') : label('Найти', 'Search')}</button>
      </div>
      <p className="text-xs text-muted-foreground">{label('Тематика соответствует поисковому запросу; язык указан по метаданным ленты. Проверьте содержание перед подключением.', 'Topics reflect the search query; language comes from feed metadata. Check content before connecting.')}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {results?.length === 0 && <p className="text-sm">{label('Новых проверенных RSS не найдено.', 'No new verified feeds found.')}</p>}
      {!!results?.length && <TableShell><thead><tr>{[label('Сайт', 'Site'), 'RSS URL', label('Тематика', 'Topics'), label('Язык', 'Language'), label('Статус', 'Status'), ''].map((title) => <Th key={title}>{title}</Th>)}</tr></thead><tbody>{results.map((item) => <tr key={item.url}><Td>{item.name}</Td><Td><a href={item.url} target="_blank" rel="noreferrer" className="text-blue underline break-all">{item.url}</a></Td><Td>{item.topics}</Td><Td>{item.language}</Td><Td>{label('Проверен', 'Verified')}</Td><Td><button type="button" disabled={busy} onClick={() => run(item.url)} className="label-mono border border-hairline px-3 py-2 disabled:opacity-50">{label('Подключить', 'Connect')}</button></Td></tr>)}</tbody></TableShell>}
    </div>}
  </div>
}
