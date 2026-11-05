'use client'
import { useEffect, useRef, useState } from 'react'
export function ManualMaterialCreate({ onCreated, onCancel }: { onCreated: (item: any) => void; onCancel: () => void }) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null), requestId = useRef<string | null>(null), running = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (running.current) return
    const photos = Array.from(input.current?.files ?? [])
    if (!text.trim() || text.length > 10000) { setError('Введите название / описание до 10 000 символов.'); return }
    if (photos.length > 10 || photos.some((file) => file.size > 10 * 1024 * 1024)) { setError('До 10 фотографий, не больше 10 МБ на файл.'); return }
    requestId.current ??= crypto.randomUUID()
    const form = new FormData(); form.set('text', text); form.set('requestId', requestId.current)
    photos.forEach((file) => form.append('file', file))
    running.current = true; setBusy(true); setError('')
    try {
      const res = await fetch('/api/content-factory/items?project=istraart', { method: 'POST', body: form })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.id) throw new Error(data?.error || 'Сохранение не подтверждено. Повторите с теми же данными.')
      if (alive.current) onCreated(data)
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'Ошибка сохранения.') }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  return <form onSubmit={save} aria-label="Добавить материал IstraArt" className="flex flex-col gap-4 border border-hairline bg-card p-5">
    <h2 className="label-mono">Добавить материал</h2>
    <label className="flex flex-col gap-2 text-sm">Название / описание<textarea required maxLength={10000} rows={4} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} className="border border-hairline bg-card p-3" /></label>
    <label className="flex flex-col gap-2 text-sm">Фотографии<input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy} className="min-w-0 text-sm" /><span className="text-xs text-muted-foreground">JPEG, PNG, WebP — до 10 фото, до 10 МБ каждое.</span></label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-2"><button type="submit" disabled={busy} className="label-mono border border-foreground bg-foreground px-4 py-2 text-background disabled:opacity-50">{busy ? 'Сохранение…' : 'Сохранить'}</button><button type="button" disabled={busy} onClick={onCancel} className="label-mono border border-hairline px-4 py-2 disabled:opacity-50">Отмена</button></div>
  </form>
}
