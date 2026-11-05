'use client'
import { useRef, useState } from 'react'
import { suggestCatalogCard, type OfferKind } from '@/lib/catalog-card'
import { catalogResponseError } from '@/lib/catalog-http'
type Card = { id: string; content_item_id: string; slug: string; card_kind: string; parent_card_id: string | null; title: string }
type Task = { kind: OfferKind; card: ReturnType<typeof suggestCatalogCard>; id?: string }
export function CatalogCardCreate({ project, item, cards, disabled, onCreated, beforeCreate, onBusyChange }: {
  project: string; item: { id: string; originalText?: string; ownBrief?: string }; cards: Card[]; disabled: boolean; onCreated: (id?: string) => Promise<void>; beforeCreate: () => boolean; onBusyChange: (busy: boolean) => void
}) {
  const [chosen, setChosen] = useState<OfferKind[]>([]), [parent, setParent] = useState(''), [phase, setPhase] = useState<'idle'|'running'|'error'|'done'>('idle'), [message, setMessage] = useState('')
  const plan = useRef<{ tasks: Task[]; parent: string } | null>(null), running = useRef(false)
  const labels = { raw: 'Исходный материал', finished: 'Готовое изделие', guide: 'DIY-гайд' }
  const url = `/api/catalog/cards?project=${encodeURIComponent(project)}`
  async function create() {
    if (running.current || phase === 'done' || disabled) return
    if (!chosen.length || (chosen.includes('guide') && (!parent || (parent === 'new' && !chosen.includes('finished'))))) { setMessage('Выберите типы карточек и конкретное изделие для гайда.'); return }
    if (!plan.current && !beforeCreate()) return
    if (!plan.current) plan.current = { parent, tasks: (['finished','raw','guide'] as const).filter((kind) => chosen.includes(kind)).map((kind) => ({ kind, card: suggestCatalogCard({ ...item, id: crypto.randomUUID() }) })) }
    const batch = plan.current, retry = phase === 'error'
    running.current = true; onBusyChange(true); setPhase('running'); setMessage('')
    try {
      // Stable slugs let an uncertain response be reconciled before retrying a POST.
      const response = retry ? await fetch(url, { cache: 'no-store' }) : null
      if (response && !response.ok) throw new Error(await catalogResponseError(response, 'Не удалось проверить ранее созданные карточки.'))
      const known: Card[] = response ? await response.json() : cards
      for (const task of batch.tasks) {
        if (task.id) continue
        const parentId = task.kind === 'guide' ? batch.parent === 'new' ? batch.tasks.find((t) => t.kind === 'finished')?.id : batch.parent : null
        if (task.kind === 'guide' && !parentId) throw new Error('Сначала создайте или выберите изделие для гайда.')
        const existing = known.find((c) => c.content_item_id === item.id && c.slug === task.card.slug && c.card_kind === task.kind && (c.parent_card_id ?? null) === parentId)
        if (existing) { task.id = existing.id; continue }
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentItemId: item.id, cardKind: task.kind, parentCardId: parentId, card: task.card }) })
        if (!res.ok) throw new Error(await catalogResponseError(res, 'Не удалось создать карточку. Уже созданные черновики сохранены.'))
        const data = await res.json()
        if (typeof data.id !== 'string') throw new Error('Ответ создания не подтверждён. Повторите проверку.')
        task.id = data.id
      }
      setPhase('done'); setMessage('Карточки созданы как независимые черновики. Заполните и опубликуйте каждую отдельно.')
    } catch (error) { setPhase('error'); setMessage(error instanceof Error ? error.message : 'Ошибка создания. Уже созданные карточки сохранены.') }
    finally { try { await onCreated(batch.tasks.find((t) => t.id)?.id) } finally { running.current = false; onBusyChange(false) } }
  }
  return <div className="flex flex-col gap-3 border-b border-hairline pb-4">
    <div className="flex flex-wrap gap-3">{(['raw','finished','guide'] as const).map((kind) => <label key={kind} className="flex gap-2 text-sm"><input type="checkbox" checked={chosen.includes(kind)} disabled={disabled || phase !== 'idle'} onChange={(e) => { setChosen((current) => e.target.checked ? [...current, kind] : current.filter((v) => v !== kind)); setMessage('') }} />{labels[kind]}</label>)}</div>
    {chosen.includes('guide') && <label className="flex flex-col gap-1 text-sm">Изделие для DIY-гайда<select aria-label="Изделие для DIY-гайда" value={parent} disabled={disabled || phase !== 'idle'} onChange={(e) => setParent(e.target.value)} className="min-w-0 border border-hairline bg-card p-2"><option value="">Выберите конкретное изделие</option>{chosen.includes('finished') && <option value="new">Новое изделие из этой подборки</option>}{cards.filter((c) => c.card_kind === 'finished' && c.content_item_id === item.id).map((c) => <option key={c.id} value={c.id}>{c.title} · {c.slug}</option>)}</select></label>}
    <div className="flex flex-wrap gap-2"><button type="button" disabled={disabled || phase === 'running' || phase === 'done'} onClick={create} className="label-mono border border-hairline px-3 py-2 disabled:opacity-50">{phase === 'error' ? 'Продолжить создание' : 'Создать карточки'}</button>
      {(phase === 'done' || phase === 'error') && <button type="button" disabled={disabled || running.current} onClick={() => { plan.current = null; setChosen([]); setParent(''); setPhase('idle'); setMessage('') }} className="label-mono px-3 py-2 underline">Новая подборка</button>}
    </div>
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>
}
