'use client'
import { useRef, useState } from 'react'
import { suggestCatalogCard, type OfferKind } from '@/lib/catalog-card'
import { catalogResponseError } from '@/lib/catalog-http'
type Card = { id: string; content_item_id: string; slug: string; card_kind: string; parent_card_id: string | null; title: string }
type ProductKind = Extract<OfferKind, 'raw' | 'finished'>
type Task = { kind: ProductKind; card: ReturnType<typeof suggestCatalogCard>; id?: string }
export function CatalogCardCreate({ project, item, cards, disabled, onCreated, beforeCreate, onBusyChange }: {
  project: string; item: { id: string; originalText?: string; ownBrief?: string }; cards: Card[]; disabled: boolean; onCreated: (id?: string) => Promise<void>; beforeCreate: () => boolean; onBusyChange: (busy: boolean) => void
}) {
  const [kind, setKind] = useState<ProductKind>('finished'), [phase, setPhase] = useState<'idle'|'running'|'error'|'done'>('idle'), [message, setMessage] = useState('')
  const plan = useRef<Task | null>(null), running = useRef(false)
  const labels = { raw: 'Исходный материал', finished: 'Готовое изделие' }
  const url = `/api/catalog/cards?project=${encodeURIComponent(project)}`
  async function create() {
    if (running.current || phase === 'done' || disabled) return
    if (!plan.current && !beforeCreate()) return
    if (!plan.current) plan.current = { kind, card: suggestCatalogCard({ ...item, id: crypto.randomUUID() }) }
    const task = plan.current, retry = phase === 'error'
    running.current = true; onBusyChange(true); setPhase('running'); setMessage('')
    try {
      // Stable slugs let an uncertain response be reconciled before retrying a POST.
      const response = retry ? await fetch(url, { cache: 'no-store' }) : null
      if (response && !response.ok) throw new Error(await catalogResponseError(response, 'Не удалось проверить ранее созданные карточки.'))
      const known: Card[] = response ? await response.json() : cards
      if (!task.id) {
        const existing = known.find((c) => c.content_item_id === item.id && c.slug === task.card.slug && c.card_kind === task.kind && c.parent_card_id == null)
        if (existing) task.id = existing.id
        else {
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentItemId: item.id, cardKind: task.kind, parentCardId: null, card: task.card }) })
          if (!res.ok) throw new Error(await catalogResponseError(res, 'Не удалось создать товар.'))
          const data = await res.json()
          if (typeof data.id !== 'string') throw new Error('Ответ создания не подтверждён. Повторите проверку.')
          task.id = data.id
        }
      }
      setPhase('done'); setMessage('Товар создан как черновик. Заполните его и опубликуйте на сайте.')
    } catch (error) { setPhase('error'); setMessage(error instanceof Error ? error.message : 'Ошибка создания. Существующие товары сохранены.') }
    finally { try { await onCreated(task.id) } finally { running.current = false; onBusyChange(false) } }
  }
  return <div className="flex flex-col gap-3 border-b border-hairline pb-4">
    <fieldset disabled={disabled || phase !== 'idle'} className="flex flex-wrap gap-3"><legend className="mb-2 text-sm">Тип нового товара</legend>{(['raw','finished'] as const).map((value) => <label key={value} className="flex gap-2 text-sm"><input type="radio" name={`product-kind-${item.id}`} checked={kind === value} onChange={() => { setKind(value); setMessage('') }} />{labels[value]}</label>)}</fieldset>
    <div className="flex flex-wrap gap-2"><button type="button" disabled={disabled || phase === 'running' || phase === 'done'} onClick={create} className="label-mono border border-hairline px-3 py-2 disabled:opacity-50">{phase === 'error' ? 'Проверить создание' : 'Создать товар'}</button>
      {(phase === 'done' || phase === 'error') && <button type="button" disabled={disabled || running.current} onClick={() => { plan.current = null; setPhase('idle'); setMessage('') }} className="label-mono px-3 py-2 underline">Ещё один товар</button>}
    </div>
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>
}
