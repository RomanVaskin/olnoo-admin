'use client'
import { useEffect, useState } from 'react'
import type { CatalogCardInput, CatalogOffers, OfferKind } from '@/lib/catalog-card'

type Source = { id: string; originalImageFiles: string[] }
type Row = { id: string; content_item_id: string; slug: string; title: string; description: string; length_cm: number | string | null; diameter_cm: number | string | null; offers: CatalogOffers; published_at: string | null }
const labels: Record<OfferKind, string> = { raw: 'Заготовка', finished: 'Готовое изделие', guide: 'DIY-гайд' }
const kinds = ['raw', 'finished', 'guide'] as const
const empty = (): CatalogCardInput => ({ slug: '', title: '', description: '', lengthCm: null, diameterCm: null, offers: {} })
export function CatalogCardEditor({ project, item }: { project: string; item: Source }) {
  const [open, setOpen] = useState(false)
  const [row, setRow] = useState<Row | null>(null)
  const [draft, setDraft] = useState<CatalogCardInput>(empty)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const url = `/api/catalog/cards?project=${encodeURIComponent(project)}`
  async function load() {
    setLoading(true); setError('')
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error('Не удалось загрузить карточку каталога.')
      const rows = await res.json() as Row[]
      const current = rows.find((r) => r.content_item_id === item.id) ?? null
      setRow(current)
      setDraft(current ? { slug: current.slug, title: current.title, description: current.description, lengthCm: current.length_cm == null ? null : Number(current.length_cm), diameterCm: current.diameter_cm == null ? null : Number(current.diameter_cm), offers: current.offers } : empty())
      setDirty(false)
    } catch (err) { setError(err instanceof Error ? err.message : 'Ошибка загрузки.') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (open) void load() }, [open, project, item.id])
  function change(patch: Partial<CatalogCardInput>) { setDraft((d) => ({ ...d, ...patch })); setDirty(true) }
  function offer(kind: OfferKind, patch: Partial<NonNullable<CatalogOffers[OfferKind]>>) {
    change({ offers: { ...draft.offers, [kind]: { ...draft.offers[kind], ...patch } } })
  }
  async function action(action?: 'publish' | 'unpublish') {
    setBusy(true); setError('')
    try {
      const res = await fetch(row ? `/api/catalog/cards/${row.id}?project=${encodeURIComponent(project)}` : url, { method: row ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action ? { action } : row ? { card: draft } : { contentItemId: item.id, card: draft }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Ошибка сохранения карточки.')
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Ошибка запроса.') }
    finally { setBusy(false) }
  }
  const field = 'border border-hairline bg-card px-3 py-2 text-sm'
  return <div className="flex flex-col gap-3 border border-hairline bg-card p-4">
    <button type="button" onClick={() => setOpen(!open)} className="label-mono text-left">Карточка каталога · {open ? 'Скрыть' : 'Оформить / редактировать'}</button>
    {open && <>
      <p className="text-sm text-muted-foreground">{row?.published_at ? 'Опубликована на сайте. Сохранённые изменения обновят ту же карточку.' : 'Черновик. На сайте не отображается до публикации.'}</p>
      <p className="text-xs text-muted-foreground">Добавляйте только подтверждённые предложения. Для каждого нужны описание, цена в ₽, доступность и выбранные фотографии. PDF не загружается и не выдаётся публично.</p>
      {loading ? <p>Загрузка…</p> : <fieldset disabled={busy} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">Название<input value={draft.title} onChange={(e) => change({ title: e.target.value })} maxLength={160} className={field} /></label>
        <label className="flex flex-col gap-1 text-sm">Адрес карточки (латиница, цифры, дефисы)<input value={draft.slug} onChange={(e) => change({ slug: e.target.value })} maxLength={100} className={field} /></label>
        <label className="flex flex-col gap-1 text-sm">Описание находки<textarea value={draft.description} onChange={(e) => change({ description: e.target.value })} maxLength={10000} className={field} /></label>
        <div className="grid grid-cols-2 gap-3">{(['lengthCm', 'diameterCm'] as const).map((key) => <label key={key} className="flex flex-col gap-1 text-sm">{key === 'lengthCm' ? 'Длина, см' : 'Диаметр, см'}<input type="number" min="0.01" step="0.01" value={draft[key] ?? ''} onChange={(e) => change({ [key]: e.target.value === '' ? null : Number(e.target.value) })} className={field} /></label>)}</div>
        {kinds.map((kind) => {
          const value = draft.offers[kind]
          return <fieldset key={kind} className="flex flex-col gap-3 border border-hairline p-3">
            <label className="flex gap-2 text-sm font-medium"><input type="checkbox" checked={!!value} onChange={(e) => {
              const next = { ...draft.offers }
              if (e.target.checked) next[kind] = { title: '', description: '', priceRub: 0, available: false, imageIndexes: [] }
              else delete next[kind]
              change({ offers: next })
            }} />{labels[kind]}</label>
            {value && <>
              <label className="flex flex-col gap-1 text-sm">Название предложения<input value={value.title} onChange={(e) => offer(kind, { title: e.target.value })} maxLength={160} className={field} /></label>
              <label className="flex flex-col gap-1 text-sm">Описание<textarea value={value.description} onChange={(e) => offer(kind, { description: e.target.value })} maxLength={5000} className={field} /></label>
              <label className="flex flex-col gap-1 text-sm">Подтверждённая цена, ₽<input type="number" min="1" step="1" value={value.priceRub || ''} onChange={(e) => offer(kind, { priceRub: Number(e.target.value) })} className={field} /></label>
              <label className="flex flex-col gap-1 text-sm">Доступность<select value={value.available ? 'yes' : 'no'} onChange={(e) => offer(kind, { available: e.target.value === 'yes' })} className={field}><option value="no">Недоступно</option><option value="yes">Доступно для заказа / покупки</option></select></label>
              <div className="grid grid-cols-3 gap-2">{item.originalImageFiles.map((filename, index) => <label key={filename} className="flex flex-col gap-1 text-xs"><img src={`/api/content-factory/items/${item.id}/original-images/${index}?project=${encodeURIComponent(project)}`} alt={`Фото ${index + 1}`} className="aspect-square object-cover border border-hairline" /><span><input type="checkbox" checked={value.imageIndexes.includes(index)} onChange={(e) => offer(kind, { imageIndexes: e.target.checked ? [...value.imageIndexes, index] : value.imageIndexes.filter((n) => n !== index) })} /> Фото {index + 1}</span></label>)}</div>
            </>}
          </fieldset>
        })}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => action()} disabled={!dirty && !!row} className={`${field} disabled:opacity-50`}>Сохранить карточку</button>
          <button type="button" onClick={() => action('publish')} disabled={!row || dirty || !!row.published_at} className={`${field} disabled:opacity-50`}>Опубликовать</button>
          {row?.published_at && <button type="button" onClick={() => action('unpublish')} disabled={dirty} className={field}>Снять с публикации</button>}
        </div>
      </fieldset>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </>}
  </div>
}
