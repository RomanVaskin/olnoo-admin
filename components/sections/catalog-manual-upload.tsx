'use client'
import { useEffect, useRef, useState } from 'react'
import type { ManualCatalogPhoto } from '@/lib/catalog-manual-photo-data'
type OwnItem = { id: string; originKind: string; originalText: string; originalImageFiles: string[] }
export function CatalogManualUpload({ cardId, project, disabled, onMedia }: { cardId: string; project: string; disabled: boolean; onMedia: (media: ManualCatalogPhoto[]) => void }) {
  const [kind, setKind] = useState(''), [slot, setSlot] = useState('0'), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [items, setItems] = useState<OwnItem[]>([]), [source, setSource] = useState('')
  const input = useRef<HTMLInputElement>(null), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function telegramItems() {
    setMessage(''); setBusy(true)
    try { const r = await fetch(`/api/content-factory/items?project=${encodeURIComponent(project)}`, { cache: 'no-store' }); if (!r.ok) throw new Error('Не удалось загрузить Telegram-материалы.'); const data = await r.json(); if (alive.current) setItems(data.filter((i: OwnItem) => i.originKind === 'own' && i.originalImageFiles.length)) }
    catch (e) { if (alive.current) setMessage(e instanceof Error ? e.message : 'Ошибка загрузки.') }
    finally { if (alive.current) setBusy(false) }
  }
  async function upload(telegram = false) {
    if (!kind) { setMessage('Укажите: реальное фото или ИИ-визуализация.'); return }
    let body: FormData | string, headers: Record<string,string> = {}
    if (telegram) {
      if (!source) return
      const [itemId, index] = source.split(':')
      body = JSON.stringify({ itemId, index: Number(index), kind, slot: Number(slot) }); headers = { 'Content-Type': 'application/json' }
    } else {
      const file = input.current?.files?.[0]
      if (!file) { setMessage('Выберите файл.'); return }
      const form = new FormData(); form.set('file', file); form.set('kind', kind); form.set('slot', slot); body = form
    }
    setBusy(true); setMessage('')
    try { const r = await fetch(`/api/catalog/cards/${cardId}/media?project=${encodeURIComponent(project)}`, { method: 'POST', headers, body }); const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Ошибка загрузки.'); if (alive.current) { onMedia(data.media); setMessage('Изображение добавлено. Отметьте позицию фото и выберите файл в предложении ниже. Публикация не выполнялась.'); if (input.current) input.current.value = '' } }
    catch (e) { if (alive.current) setMessage(e instanceof Error ? e.message : 'Ошибка загрузки.') }
    finally { if (alive.current) setBusy(false) }
  }
  return <fieldset disabled={busy || disabled} className="flex flex-col gap-3 border border-hairline p-3">
    <legend className="label-mono px-1">Добавить фото в эту карточку</legend>
    <p className="text-xs text-muted-foreground">JPEG / PNG / WebP до 10 МБ. Оригиналы не изменяются. В каждой из 10 позиций можно хранить варианты и вручную выбрать один. Тип изображения указывает владелец; ИИ-визуализация не подтверждает существование изготовленного товара.</p>
    <label className="text-sm">Тип изображения<select value={kind} onChange={(e) => setKind(e.target.value)} className="ml-2 border border-hairline bg-card p-2"><option value="">Выберите тип</option><option value="real">Реальное фото</option><option value="ai">ИИ-визуализация</option></select></label>
    <label className="text-sm">Позиция фото<select value={slot} onChange={(e) => setSlot(e.target.value)} className="ml-2 border border-hairline bg-card p-2">{Array.from({ length: 10 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}</select></label>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Файл изображения" className="text-sm" />
    <button type="button" onClick={() => upload()} className="label-mono self-start border border-hairline px-3 py-2">Загрузить из Admin</button>
    <p className="text-xs text-muted-foreground">Через Telegram: отправьте фото существующему боту, выберите IstraArt, затем выберите полученный собственный материал здесь.</p>
    <button type="button" onClick={telegramItems} className="label-mono self-start border border-hairline px-3 py-2">Выбрать фото из Telegram</button>
    {!!items.length && <><select aria-label="Фото из Telegram" value={source} onChange={(e) => setSource(e.target.value)} className="border border-hairline bg-card p-2 text-sm"><option value="">Выберите фотографию</option>{items.flatMap((i) => i.originalImageFiles.map((_, index) => <option key={`${i.id}:${index}`} value={`${i.id}:${index}`}>{i.originalText?.slice(0, 80) || `Собственный материал ${i.id.slice(0, 8)}`} · фото {index + 1}</option>))}</select>{source && <img src={`/api/content-factory/items/${source.split(':')[0]}/original-images/${source.split(':')[1]}?project=${encodeURIComponent(project)}`} alt="Выбранное фото из Telegram" className="aspect-square w-40 border border-hairline object-contain" />}<button type="button" disabled={!source} onClick={() => upload(true)} className="label-mono self-start border border-hairline px-3 py-2">Прикрепить к карточке</button></>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </fieldset>
}
