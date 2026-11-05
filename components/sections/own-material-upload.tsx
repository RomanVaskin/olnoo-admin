'use client'
import { useRef, useState } from 'react'
export function OwnMaterialUpload({ itemId, disabled, onUpdated }: { itemId: string; disabled: boolean; onUpdated: (item: any) => void }) {
  const input = useRef<HTMLInputElement>(null), running = useRef(false)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  async function upload() {
    const files = Array.from(input.current?.files ?? [])
    if (!files.length || disabled || running.current) return
    running.current = true; setBusy(true); setMessage('')
    try {
      for (const file of files) {
        const form = new FormData(); form.set('file', file)
        const res = await fetch(`/api/content-factory/items/${itemId}/original-images?project=istraart`, { method: 'POST', body: form })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Не удалось загрузить исходное фото.')
        if (!data?.id) throw new Error('Загрузка не подтверждена. Обновите материал перед повтором.')
        onUpdated(data)
      }
      setMessage('Исходные фото добавлены без изменения файлов.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Ошибка загрузки. Предыдущие фото сохранены.') }
    finally { running.current = false; setBusy(false); if (input.current) input.current.value = '' }
  }
  return <div className="flex flex-col gap-2">
    <p className="text-xs text-muted-foreground">Текст и фото можно отправить существующему Telegram-боту и выбрать проект IstraArt. Дополнительные оригиналы — загрузить здесь до подготовки материала.</p>
    <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Исходные фотографии" disabled={disabled || busy} onChange={upload} />
    <button type="button" disabled={disabled || busy} onClick={() => input.current?.click()} className="label-mono self-start border border-hairline px-3 py-2 disabled:opacity-50">{busy ? 'Загрузка…' : 'Загрузить исходные фото'}</button>
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>
}
