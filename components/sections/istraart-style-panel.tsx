'use client'
import { useEffect, useState } from 'react'
import { catalogResponseError } from '@/lib/catalog-http'
import { ISTRAART_STYLE_NAME, buildIstraArtChatGptPrompt, validateIstraArtStyle } from '@/lib/istraart-style'
import type { CatalogCardInput, OfferKind } from '@/lib/catalog-card'
const url = '/api/projects/istraart-style?project=istraart'
const field = 'w-full border border-hairline bg-card p-3 text-sm'
async function fetchStyle() {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(await catalogResponseError(response, 'Не удалось загрузить промпт IstraArt.'))
  return validateIstraArtStyle((await response.json()).prompt)
}
export function IstraArtStylePanel() {
  const [prompt, setPrompt] = useState(''), [saved, setSaved] = useState(''), [busy, setBusy] = useState(true), [message, setMessage] = useState('')
  async function load(isCurrent = () => true) {
    setBusy(true); setMessage('')
    try { const value = await fetchStyle(); if (isCurrent()) { setPrompt(value); setSaved(value) } }
    catch (error) { if (isCurrent()) setMessage(error instanceof Error ? error.message : 'Не удалось загрузить промпт IstraArt.') }
    finally { if (isCurrent()) setBusy(false) }
  }
  useEffect(() => { let alive = true; void load(() => alive); return () => { alive = false } }, [])
  async function save() {
    setBusy(true); setMessage('')
    try { const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) }); const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Ошибка сохранения.'); setPrompt(data.prompt); setSaved(data.prompt); setMessage('Промпт сохранён.') }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Ошибка сохранения.') }
    finally { setBusy(false) }
  }
  return <section className="flex flex-col gap-3 border border-hairline bg-card p-6">
    <h3 className="label-mono">{ISTRAART_STYLE_NAME}</h3>
    <p className="text-sm text-muted-foreground">Единый промпт проекта для ручной работы в ChatGPT. Копирование с контекстом — в выбранной карточке каталога. Вызовы ИИ API не выполняются.</p>
    <textarea aria-label={ISTRAART_STYLE_NAME} value={prompt} maxLength={16000} rows={18} onChange={(e) => setPrompt(e.target.value)} disabled={busy || !saved} className={field} />
    <button onClick={save} disabled={busy || !saved || prompt === saved} className="label-mono self-start border border-hairline px-4 py-2 disabled:opacity-50">Сохранить промпт</button>
    {!saved && !busy && <button type="button" onClick={() => load()} className="label-mono self-start border border-hairline px-3 py-2">Повторить загрузку промпта</button>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>
}
export function IstraArtChatGptPrompt({ task, card, originalText }: { task: OfferKind; card: Pick<CatalogCardInput, 'title'|'description'|'lengthCm'|'diameterCm'> & { offers: Partial<Record<OfferKind, { description: string }>> }; originalText: string }) {
  const [style, setStyle] = useState<string | null>(null), [message, setMessage] = useState(''), [loading, setLoading] = useState(true)
  async function load(isCurrent = () => true) {
    setLoading(true); setMessage('')
    try { const value = await fetchStyle(); if (isCurrent()) setStyle(value) }
    catch (error) { if (isCurrent()) setMessage(error instanceof Error ? error.message : 'Не удалось загрузить промпт IstraArt.') }
    finally { if (isCurrent()) setLoading(false) }
  }
  useEffect(() => { let alive = true; void load(() => alive); return () => { alive = false } }, [])
  const text = style ? buildIstraArtChatGptPrompt(style, task, card, originalText) : ''
  async function copy() {
    try { await navigator.clipboard.writeText(text); setMessage('Промпт скопирован. Приложите исходные фото в ChatGPT вручную.') }
    catch { setMessage('Автоматическое копирование недоступно. Выделите и скопируйте текст ниже.') }
  }
  return <section className="flex flex-col gap-2 border border-hairline p-3">
    <h3 className="label-mono">{ISTRAART_STYLE_NAME}</h3>
    <button type="button" disabled={!text} onClick={copy} className="label-mono self-start border border-hairline px-3 py-2 disabled:opacity-50">Скопировать промпт для ChatGPT</button>
    {text && <details><summary className="cursor-pointer text-sm">Посмотреть промпт</summary><textarea aria-label="Промпт для ChatGPT" readOnly value={text} rows={12} className={field} /></details>}
    {!style && !loading && <button type="button" onClick={() => load()} className="label-mono self-start border border-hairline px-3 py-2">Повторить загрузку промпта</button>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>
}
