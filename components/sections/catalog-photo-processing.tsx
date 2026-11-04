'use client'
import { useEffect, useRef, useState } from 'react'
export type CatalogPhotoPreview = { id: string; originalIndex: number; model: string; createdAt: string }
export function CatalogPhotoProcessing({ project, itemId, photoCount, disabled, onVersions }: { project: string; itemId: string; photoCount: number; disabled: boolean; onVersions: (versions: CatalogPhotoPreview[]) => void }) {
  const [versions, setVersions] = useState<CatalogPhotoPreview[]>([])
  const [comparison, setComparison] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const url = `/api/catalog/photo-processing/${itemId}?project=${encodeURIComponent(project)}`
  async function load() {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error('Не удалось загрузить версии фото. Оригиналы доступны ниже.')
    const data = await response.json() as CatalogPhotoPreview[]
    if (alive.current) { setVersions(data); onVersions(data) }
  }
  useEffect(() => { alive.current = true; onVersions([]); void load().catch((err) => setError(err.message)); return () => { alive.current = false } }, [project, itemId])
  async function process(originalIndex: number) {
    setBusy(true); setError('')
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ originalIndex }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось обработать фото. Оригинал сохранён.')
      setComparison((prev) => ({ ...prev, [originalIndex]: result.id }))
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Ошибка обработки. Оригинал сохранён.') }
    finally { setBusy(false) }
  }
  return <section className="flex flex-col gap-3 border border-hairline p-3">
    <h3 className="label-mono">Подготовка фото IstraArt</h3>
    <p className="text-xs text-muted-foreground">ИИ заменяет фон на #F5F5F3 и добавляет мягкую тень. Может изменить детали дерева: сравните форму, пропорции, цвет и текстуру. Оригиналы и все версии сохраняются. Стоимость обработки: недоступно. Обработка сама не выбирает фото и не публикует карточку.</p>
    {Array.from({ length: photoCount }, (_, index) => {
      const photos = versions.filter((v) => v.originalIndex === index)
      const selected = comparison[index] ?? photos[photos.length - 1]?.id
      return <div key={index} className="flex flex-col gap-2 border-t border-hairline pt-3">
        <span className="text-sm">Фото {index + 1}</span>
        <div className="grid grid-cols-2 gap-2">
          <figure><img src={`/api/content-factory/items/${itemId}/original-images/${index}?project=${encodeURIComponent(project)}`} alt={`Оригинал ${index + 1}`} className="aspect-square w-full object-contain bg-background" /><figcaption className="text-xs">Оригинал</figcaption></figure>
          {selected && <figure><img src={`/api/catalog/photo-processing/${itemId}/${selected}?project=${encodeURIComponent(project)}`} alt={`Обработанное фото ${index + 1}`} className="aspect-square w-full object-contain bg-background" /><figcaption className="text-xs">Обработанное фото</figcaption></figure>}
        </div>
        {!!photos.length && <select aria-label={`Версия для сравнения фото ${index + 1}`} value={selected} onChange={(e) => setComparison((prev) => ({ ...prev, [index]: e.target.value }))} className="border border-hairline bg-card p-2 text-sm">{photos.map((v, i) => <option key={v.id} value={v.id}>Версия {i + 1} · {v.model} · {new Date(v.createdAt).toLocaleString('ru-RU')}</option>)}</select>}
        <button type="button" disabled={busy || disabled} onClick={() => process(index)} className="label-mono self-start border border-hairline px-3 py-2 disabled:opacity-50">{busy ? 'Обработка…' : photos.length ? 'Обработать ещё раз' : 'Обработать фон'}</button>
      </div>
    })}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
