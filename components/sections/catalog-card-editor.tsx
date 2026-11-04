'use client'
import { useEffect, useState } from 'react'
import { catalogResponseError } from '@/lib/catalog-http'
import { IstraArtChatGptPrompt } from '@/components/sections/istraart-style-panel'
import { CatalogManualUpload } from '@/components/sections/catalog-manual-upload'
import { manualCatalogPhotos, manualPhotoCount, manualPhotoSelectionValid, type ManualCatalogPhoto } from '@/lib/catalog-manual-photo-data'
import { catalogCardErrors, suggestCatalogCard, type CatalogCardInput, type CatalogOffers, type OfferKind, type Offer, type CatalogFieldErrors, type CatalogCardKind } from '@/lib/catalog-card'

type Source = { id: string; originalImageFiles: string[]; originalText?: string; generatedTitle?: string; ownBrief?: string }
type DraftOffer = Omit<Offer, 'available'> & { available: boolean | null }
type Draft = Omit<CatalogCardInput, 'offers'> & { offers: Partial<Record<OfferKind, DraftOffer>> }
type Row = { id: string; content_item_id: string; card_kind: CatalogCardKind; parent_card_id: string | null; slug: string; title: string; description: string; length_cm: number | string | null; diameter_cm: number | string | null; offers: CatalogOffers; manual_media: ManualCatalogPhoto[]; manual_photo_selection: Record<string,string>; published_at: string | null }
const labels: Record<OfferKind, string> = { raw: 'Заготовка', finished: 'Готовое изделие', guide: 'DIY-гайд' }
const kinds = ['raw', 'finished', 'guide'] as const
const empty = (): CatalogCardInput => ({ slug: '', title: '', description: '', lengthCm: null, diameterCm: null, offers: {} })
export function CatalogCardEditor({ project, item }: { project: string; item: Source }) {
  const [open, setOpen] = useState(false)
  const [row, setRow] = useState<Row | null>(null)
  const [cards, setCards] = useState<Row[]>([])
  const [newKind, setNewKind] = useState<Exclude<CatalogCardKind, 'legacy'>>('finished')
  const [parentId, setParentId] = useState<string | null>(null)
  const [createRaw, setCreateRaw] = useState(false)
  const [createGuide, setCreateGuide] = useState(false)
  const [copyTask, setCopyTask] = useState<OfferKind>('finished')
  const [draft, setDraft] = useState<Draft>(empty)
  const [serverErrors, setServerErrors] = useState<CatalogFieldErrors>({})
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const url = `/api/catalog/cards?project=${encodeURIComponent(project)}`
  async function load(preferredId?: string) {
    setLoading(true); setLoaded(false); setError(''); setServerErrors({})
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(await catalogResponseError(res, 'Не удалось загрузить карточку каталога.'))
      const rows = await res.json() as Row[]
      const ownCards = rows.filter((r) => r.content_item_id === item.id)
      setCards(ownCards)
      const current = ownCards.find((r) => r.id === (preferredId ?? row?.id)) ?? ownCards[0]
      if (current) selectCard(current)
      else startNew('finished', null, false)
      setLoaded(true)
    } catch (err) { setError(err instanceof Error ? err.message : 'Ошибка загрузки.') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (open) void load() }, [open, project, item.id])
  function selectCard(current: Row) {
    setRow(current); setError(''); setServerErrors({}); setCreateRaw(false); setCreateGuide(false)
    setDraft({ slug: current.slug, title: current.title, description: current.description, lengthCm: current.length_cm == null ? null : Number(current.length_cm), diameterCm: current.diameter_cm == null ? null : Number(current.diameter_cm), offers: current.offers, manualPhotoSelection: current.manual_photo_selection ?? {} })
    setDirty(false)
  }
  function discardChanges() { return !dirty || window.confirm('Несохранённые изменения будут потеряны. Продолжить?') }
  function startNew(kind: Exclude<CatalogCardKind, 'legacy'>, parent: string | null = null, confirm = true) {
    if (confirm && !discardChanges()) return
    setRow(null); setNewKind(kind); setParentId(parent); setCreateRaw(false); setCreateGuide(false); setServerErrors({}); setError('')
    setDraft(suggestCatalogCard({ ...item, id: crypto.randomUUID() })); setDirty(true)
  }
  const cardKind = row?.card_kind ?? newKind
  const visibleKinds = cardKind === 'legacy' ? kinds : kinds.filter((kind) => kind === cardKind)
  function change(patch: Partial<Draft>) {
    setServerErrors({}); setDraft((d) => {
      const next = { ...d, ...patch }
      if (patch.offers) next.manualPhotoSelection = Object.fromEntries(Object.entries(next.manualPhotoSelection ?? {}).filter(([slot]) => Object.values(patch.offers!).some((offer) => offer?.imageIndexes.includes(Number(slot)))))
      return next
    }); setDirty(true)
  }
  function offer(kind: OfferKind, patch: Partial<DraftOffer>) {
    change({ offers: { ...draft.offers, [kind]: { ...draft.offers[kind], ...patch } } })
  }
  const media = manualCatalogPhotos(row?.manual_media)
  const photoCount = manualPhotoCount(item.originalImageFiles, media)
  const photoSlots = [...new Set([...item.originalImageFiles.map((_, i) => i), ...media.map((p) => p.slot)])].sort((a,b) => a-b)
  async function action(action?: 'publish' | 'unpublish') {
    if (action !== 'unpublish') {
      const errors = catalogCardErrors(draft, photoCount, action === 'publish' || !!row?.published_at, cardKind)
      if (!manualPhotoSelectionValid(draft, item.originalImageFiles, media)) errors.manualPhotoSelection = 'Выберите доступный файл для каждой отмеченной позиции.'
      if (Object.keys(errors).length) { setServerErrors(errors); setError('Проверьте отмеченные поля.'); return }
    }
    setBusy(true); setError(''); setServerErrors({})
    try {
      const res = await fetch(row ? `/api/catalog/cards/${row.id}?project=${encodeURIComponent(project)}` : url, { method: row ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action ? { action } : row ? { card: draft } : { contentItemId: item.id, card: draft, cardKind: newKind, parentCardId: parentId, createRaw, createGuide }) })
      const data = await res.json()
      if (!res.ok) { setServerErrors(data.fieldErrors || {}); throw new Error(data.error || 'Ошибка сохранения карточки.') }
      await load(data.id)
    } catch (err) { setError(err instanceof Error ? err.message : 'Ошибка запроса.') }
    finally { setBusy(false) }
  }
  const publicationErrors = catalogCardErrors(draft, photoCount, true, cardKind)
  if (!manualPhotoSelectionValid(draft, item.originalImageFiles, media)) publicationErrors.manualPhotoSelection = 'Выберите доступный файл для каждой отмеченной позиции.'
  const errors = serverErrors
  const hint = (key: string) => errors[key] ? <span id={`catalog-${item.id}-${key}`} role="alert" className="text-xs text-destructive">{errors[key]}</span> : null
  const invalid = (key: string) => ({ 'aria-invalid': !!errors[key], 'aria-describedby': errors[key] ? `catalog-${item.id}-${key}` : undefined })
  const field = 'border border-hairline bg-card px-3 py-2 text-sm'
  return <div className="flex flex-col gap-3 border border-hairline bg-card p-4">
    <button type="button" onClick={() => setOpen(!open)} className="label-mono text-left">{project === 'istraart' ? 'Каталог сайта IstraArt' : 'Каталог сайта'} · {open ? 'Скрыть' : 'Оформить / редактировать'}</button>
    {open && <>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || !loaded} onClick={() => startNew('finished')} className={`${field} disabled:opacity-50`}>Создать изделие</button>
        <button type="button" disabled={busy || !loaded} onClick={() => startNew('raw')} className={`${field} disabled:opacity-50`}>Создать карточку исходного материала</button>
        {row?.card_kind === 'finished' && <button type="button" disabled={busy || !loaded} onClick={() => startNew('guide', row.id)} className={`${field} disabled:opacity-50`}>Создать DIY-гайд для изделия</button>}
      </div>
      {!!cards.length && <label className="flex flex-col gap-1 text-sm">Карточки этого материала<select disabled={busy || !loaded} value={row?.id ?? ''} onChange={(e) => { const selected = cards.find((c) => c.id === e.target.value); if (selected && discardChanges()) selectCard(selected) }} className={field}>
        <option value="" disabled>Новая карточка</option>
        {cards.map((card) => <option key={card.id} value={card.id}>{card.card_kind === 'legacy' ? 'Прежняя карточка' : labels[card.card_kind]} · {card.title} · {card.published_at ? 'Опубликовано на сайте' : 'Черновик'}</option>)}
      </select></label>}
      <p className="text-sm">{cardKind === 'legacy' ? 'Прежняя карточка с независимыми предложениями' : labels[cardKind]}</p>
      {cardKind === 'guide' && <p className="text-sm text-muted-foreground">Изделие: {cards.find((c) => c.id === (row?.parent_card_id ?? parentId))?.title ?? '—'}. Публикуется независимо от изделия.</p>}
      <p className="text-sm text-muted-foreground">{row?.published_at ? 'Опубликовано на сайте' : 'Черновик'}</p>
      {row?.published_at && project === 'istraart' && <a href="https://istraart.ru/#catalog" target="_blank" rel="noreferrer" className="text-sm text-blue underline">Открыть каталог IstraArt</a>}
      <p className="text-xs text-muted-foreground">Сохранение оставляет новую карточку черновиком. «Опубликовать на сайте» — ручное утверждение для сайта, отдельно от соцсетей. Сохранение изменений опубликованной карточки обновляет её на сайте.</p>
      <p className="text-xs text-muted-foreground">Добавляйте только подтверждённые предложения. Для каждого нужны описание, цена в ₽, доступность и выбранные фотографии. PDF не загружается и не выдаётся публично.</p>
      {project === 'istraart' && loaded && <>
        {cardKind === 'legacy' && <label className="text-sm">Задача для ChatGPT<select value={copyTask} onChange={(e) => setCopyTask(e.target.value as OfferKind)} className="ml-2 border border-hairline bg-card p-2">{kinds.map((k) => <option key={k} value={k}>{labels[k]}</option>)}</select></label>}
        <IstraArtChatGptPrompt task={cardKind === 'legacy' ? copyTask : cardKind} card={draft} originalText={item.originalText || item.ownBrief || ''} />
        {row ? <CatalogManualUpload key={row.id} project={project} cardId={row.id} disabled={busy || !loaded} onMedia={(photos) => { const id = row.id; setRow((current) => current?.id === id ? { ...current, manual_media: photos } : current); setCards((cards) => cards.map((c) => c.id === id ? { ...c, manual_media: photos } : c)) }} /> : <p className="text-xs text-muted-foreground">Сначала сохраните черновик карточки, затем загрузите изображения.</p>}
      </>}
      {!loading && !loaded && <button type="button" disabled={busy} onClick={() => load()} className={`${field} self-start disabled:opacity-50`}>Повторить загрузку карточек</button>}
      {loading ? <p>Загрузка…</p> : loaded && <fieldset disabled={busy || !loaded} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">Название<input {...invalid('title')} value={draft.title} onChange={(e) => change({ title: e.target.value })} maxLength={160} className={field} />{hint('title')}</label>
        <label className="flex flex-col gap-1 text-sm">Адрес карточки (латиница, цифры, дефисы)<input {...invalid('slug')} value={draft.slug} onChange={(e) => change({ slug: e.target.value })} maxLength={100} className={field} />{hint('slug')}</label>
        <label className="flex flex-col gap-1 text-sm">Описание карточки<textarea {...invalid('description')} value={draft.description} onChange={(e) => change({ description: e.target.value })} maxLength={10000} className={field} />{hint('description')}</label>
        <div className="grid grid-cols-2 gap-3">{(['lengthCm', 'diameterCm'] as const).map((key) => <label key={key} className="flex flex-col gap-1 text-sm">{key === 'lengthCm' ? 'Длина, см' : 'Диаметр, см'}<input type="number" min="0.01" step="0.01" {...invalid(key)} value={draft[key] ?? ''} onChange={(e) => change({ [key]: e.target.value === '' ? null : Number(e.target.value) })} className={field} />{hint(key)}</label>)}</div>
        {hint('offers')}
        {hint('manualPhotoSelection')}
        {visibleKinds.map((kind) => {
          const value = draft.offers[kind]
          return <fieldset key={kind} className="flex flex-col gap-3 border border-hairline p-3">
            <label className="flex gap-2 text-sm font-medium"><input type="checkbox" checked={!!value} onChange={(e) => {
              const next = { ...draft.offers }
              if (e.target.checked) next[kind] = { title: draft.title || labels[kind], description: '', priceRub: 0, available: null, imageIndexes: [] }
              else delete next[kind]
              change({ offers: next })
            }} />{labels[kind]}</label>
            {value && <>
              <label className="flex flex-col gap-1 text-sm">Название предложения<input {...invalid(`offers.${kind}.title`)} value={value.title} onChange={(e) => offer(kind, { title: e.target.value })} maxLength={160} className={field} />{hint(`offers.${kind}.title`)}</label>
              <label className="flex flex-col gap-1 text-sm">Описание<textarea {...invalid(`offers.${kind}.description`)} value={value.description} onChange={(e) => offer(kind, { description: e.target.value })} maxLength={5000} className={field} />{hint(`offers.${kind}.description`)}</label>
              <label className="flex flex-col gap-1 text-sm">Подтверждённая цена, ₽<input type="number" min="1" step="1" {...invalid(`offers.${kind}.priceRub`)} value={value.priceRub || ''} onChange={(e) => offer(kind, { priceRub: Number(e.target.value) })} className={field} />{hint(`offers.${kind}.priceRub`)}</label>
              <label className="flex flex-col gap-1 text-sm">Доступность<select {...invalid(`offers.${kind}.available`)} value={value.available === null ? '' : value.available ? 'yes' : 'no'} onChange={(e) => offer(kind, { available: e.target.value === '' ? null : e.target.value === 'yes' })} className={field}><option value="">Выберите доступность</option><option value="no">Недоступно</option><option value="yes">Доступно для заказа / покупки</option></select>{hint(`offers.${kind}.available`)}</label>
              {hint(`offers.${kind}.imageIndexes`)}
              <div className="grid grid-cols-3 gap-2">{photoSlots.map((index) => {
                const selected = draft.manualPhotoSelection?.[String(index)] ?? ''
                const variants = media.filter((p) => p.slot === index)
                const src = selected && row ? `/api/catalog/cards/${row.id}/media/${selected}?project=${encodeURIComponent(project)}` : item.originalImageFiles[index] ? `/api/content-factory/items/${item.id}/original-images/${index}?project=${encodeURIComponent(project)}` : null
                return <div key={index} className="flex flex-col gap-1 text-xs">
                  {src ? <img src={src} alt={`Фото ${index + 1}`} className="aspect-square object-cover border border-hairline" /> : <span className="text-muted-foreground">Выберите изображение</span>}
                  <label><input type="checkbox" checked={value.imageIndexes.includes(index)} onChange={(e) => offer(kind, { imageIndexes: e.target.checked ? [...value.imageIndexes, index] : value.imageIndexes.filter((n) => n !== index) })} /> Фото {index + 1}</label>
                  {!!variants.length && value.imageIndexes.includes(index) && <select aria-label={`Файл для фото ${index + 1}`} value={selected} onChange={(e) => {
                    const next = { ...draft.manualPhotoSelection }
                    if (e.target.value) next[String(index)] = e.target.value
                    else delete next[String(index)]
                    change({ manualPhotoSelection: next })
                  }} className="w-full border border-hairline bg-card py-1">
                    <option value="" disabled={!item.originalImageFiles[index]}>{item.originalImageFiles[index] ? 'Исходное фото материала' : 'Выберите файл'}</option>
                    {variants.map((p, i) => <option key={p.id} value={p.id}>{p.kind === 'real' ? 'Реальное фото' : 'ИИ-визуализация'} · {i + 1}</option>)}
                  </select>}
                </div>
              })}</div>
            </>}
          </fieldset>
        })}
        {!row && newKind === 'finished' && <div className="flex flex-col gap-2 text-sm">
          <label className="flex gap-2"><input type="checkbox" checked={createRaw} onChange={(e) => setCreateRaw(e.target.checked)} />Создать карточку исходного материала</label>
          <label className="flex gap-2"><input type="checkbox" checked={createGuide} onChange={(e) => setCreateGuide(e.target.checked)} />Создать DIY-гайд для изделия</label>
          <p className="text-xs text-muted-foreground">Дополнительные карточки создаются отдельными черновиками без цены и наличия. Заполните и опубликуйте каждую отдельно.</p>
        </div>}
        <p className="text-xs text-muted-foreground">{!row ? 'Сначала сохраните черновик карточки.' : dirty ? 'Сохраните изменения перед публикацией.' : Object.keys(publicationErrors).length ? `Для публикации: ${Object.values(publicationErrors).join(' ')}` : ''}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => action()} disabled={!dirty && !!row} className={`${field} disabled:opacity-50`}>Сохранить карточку</button>
          <button type="button" onClick={() => action('publish')} disabled={!row || dirty || !!row.published_at || Object.keys(publicationErrors).length > 0} className={`${field} disabled:opacity-50`}>Опубликовать на сайте</button>
          {row?.published_at && <button type="button" onClick={() => action('unpublish')} disabled={dirty} className={field}>Снять с публикации</button>}
        </div>
      </fieldset>}
      {hint('_form')}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </>}
  </div>
}
