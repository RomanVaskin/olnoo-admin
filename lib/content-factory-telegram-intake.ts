import { unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { listProjects } from './projects-registry.ts'
import { createSource } from './content-factory-sources.ts'
import { storeNewSourceMessages } from './content-factory-items.ts'
import { originalImagePath, writeOriginalImage } from './content-factory-original-images.ts'

type Photo = { file_id: string; file_size?: number }
type Message = { video?: unknown; document?: unknown; audio?: unknown; voice?: unknown; animation?: unknown; sticker?: unknown; message_id: number; date: number; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean }; text?: string; caption?: string; photo?: Photo[]; media_group_id?: string; forward_origin?: { type: string; chat?: { username?: string }; message_id?: number } }
type Pending = { id: string; sender_id: string; chat_id: string; messages: Record<string, Message>; item_id: string | null; project_id: number | null; completed: boolean }
export type IntakeGrants = Record<string, string[]>
export function intakeGrants(raw = process.env.CONTENT_FACTORY_TELEGRAM_ACCESS): IntakeGrants {
  try {
    const value: unknown = JSON.parse(raw || '{}')
    if (!value || Array.isArray(value) || typeof value !== 'object') return {}
    const result: IntakeGrants = {}
    for (const [id, slugs] of Object.entries(value)) {
      if (!/^[1-9]\d{0,15}$/.test(id) || !Array.isArray(slugs) || !slugs.length || !slugs.every((s) => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s))) return {}
      result[id] = slugs
    }
    return result
  } catch { return {} }
}
export function privateIntakeSender(message: Message | undefined, grants: IntakeGrants): string | null {
  if (!message || message.chat?.type !== 'private' || !Number.isSafeInteger(message.from?.id) || message.from?.is_bot || message.chat.id !== message.from!.id) return null
  const id = String(message.from!.id)
  return grants[id]?.length ? id : null
}
export function intakeOriginal(messages: Record<string, Message>) {
  const ordered = Object.values(messages).sort((a, b) => a.message_id - b.message_id)
  if (!ordered.length || ordered.length > 10) throw new Error('Unsupported photo album size')
  return { text: ordered.map((m) => m.text ?? m.caption ?? '').filter((text) => text !== '').join('\n\n'),
    photos: ordered.flatMap((m) => m.photo?.length ? [m.photo[m.photo.length - 1]] : []),
    url: ordered.map((m) => m.forward_origin?.type === 'channel' && m.forward_origin.chat?.username && m.forward_origin.message_id ? `https://t.me/${m.forward_origin.chat.username}/${m.forward_origin.message_id}` : '').find(Boolean) || ordered.map((m) => /https:\/\/t\.me\/[a-zA-Z][a-zA-Z0-9_]*\/\d+/.exec(m.text ?? m.caption ?? '')?.[0]).find(Boolean) || '',
    date: new Date(ordered[0].date * 1000).toISOString() }
}
export type IntakeDeps = { bot: (method: string, data: Record<string, unknown>) => Promise<unknown>; photo: (fileId: string) => Promise<Buffer>; save?: typeof writeOriginalImage }

export async function handleOwnTelegramUpdate(pool: Pool, raw: unknown, deps: IntakeDeps, grants = intakeGrants()): Promise<boolean> {
  const update = raw as { message?: Message; callback_query?: { id: string; from: { id: number }; message?: Message; data?: string } } | null
  const callback = update?.callback_query
  const message = update?.message ?? callback?.message
  if (message?.chat?.type !== 'private') return false // Existing group comments retain their flow.
  const senderMessage = callback ? { ...message, from: callback.from } : message
  const sender = privateIntakeSender(senderMessage, grants)
  if (!sender) return true // No replies, commands or side effects for strangers.
  const projects = (await listProjects(pool)).filter((p) => grants[sender].includes(String(p.slug)))
  const send = (text: string, keyboard?: unknown) => deps.bot('sendMessage', { chat_id: message!.chat.id, text, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) })
  if (callback) {
    const match = /^cfi:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(?:(choose)|(\d+):(\d+))$/.exec(callback.data || '')
    if (!match) return true
    await deps.bot('answerCallbackQuery', { callback_query_id: callback.id })
    const client = await pool.connect()
    let response = ''; let buttons: unknown
    const createdFiles: { project: number; item: string; filename: string }[] = []
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<Pending>('SELECT * FROM content_factory_telegram_intake WHERE id = $1 AND sender_id = $2 AND chat_id = $3 FOR UPDATE', [match[1], sender, String(message!.chat.id)])
      const pending = rows[0]
      if (!pending) response = 'Материал не найден.'
      else if (pending.completed) response = 'Этот материал уже добавлен в Content Factory.'
      else {
        const count = Object.keys(pending.messages).length
        if (match[2]) {
          response = `Получено сообщений: ${count}. Если все фотографии доставлены, выберите проект:`
          buttons = projects.map((p) => [{ text: String(p.name), callback_data: `cfi:${pending.id}:${p.id}:${count}` }])
          if (!projects.length) response = 'Нет доступных активных проектов. Обратитесь к владельцу Admin.'
        } else {
          const project = projects.find((p) => Number(p.id) === Number(match[3]))
          if (!project || (pending.project_id && pending.project_id !== Number(project.id))) response = 'Нет доступа к выбранному проекту.'
          else if (Number(match[4]) !== count) response = 'Получены новые фотографии. Снова нажмите «Выбрать проект», когда альбом загружен полностью.'
          else {
            const active = await client.query('SELECT id FROM projects WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [project.id])
            if (!active.rows[0]) throw new Error('Project is no longer active')
            const original = intakeOriginal(pending.messages)
            const db = client as unknown as Pool
            let itemId = pending.item_id
            if (!itemId) {
              const handle = `own-bot:${sender}`
              const existing = await client.query('SELECT * FROM content_factory_sources WHERE project_id = $1 AND handle = $2 AND type = $3', [project.id, handle, 'telegram'])
              const source = existing.rows[0] ?? await createSource(db, Number(project.id), { type: 'telegram', handle }, true)
              await client.query('UPDATE content_factory_sources SET enabled = false WHERE id = $1 AND project_id = $2', [source.id, project.id])
              const [item] = await storeNewSourceMessages(db, Number(project.id), source.id, [{ externalId: `own:${pending.id}`, text: original.text, url: original.url, publishedAt: original.date, imageUrls: original.photos.map((p) => `telegram-file:${p.file_id}`) }])
              if (!item) throw new Error('Could not create own material')
              itemId = item.id
              await client.query("UPDATE content_factory_items SET origin_kind = 'own', status = 'processing' WHERE id = $1 AND project_id = $2", [itemId, project.id])
              await client.query('UPDATE content_factory_telegram_intake SET item_id = $1, project_id = $2 WHERE id = $3', [itemId, project.id, pending.id])
            }
            const item = (await client.query('SELECT original_image_files FROM content_factory_items WHERE id = $1 AND project_id = $2', [itemId, project.id])).rows[0]
            const files: string[] = item.original_image_files
            try {
              for (let i = files.length; i < original.photos.length; i++) {
                const filename = await (deps.save ?? writeOriginalImage)(Number(project.id), itemId, await deps.photo(original.photos[i].file_id))
                createdFiles.push({ project: Number(project.id), item: itemId, filename })
                files.push(filename)
                await client.query('UPDATE content_factory_items SET original_image_files = $1::jsonb WHERE id = $2 AND project_id = $3', [JSON.stringify(files), itemId, project.id])
              }
              await client.query("UPDATE content_factory_items SET status = 'new', original_image_error = '', error = '' WHERE id = $1 AND project_id = $2", [itemId, project.id])
              await client.query('UPDATE content_factory_telegram_intake SET completed = true WHERE id = $1', [pending.id])
              response = `Собственный материал добавлен в ${project.name}. Обработка и утверждение — в OLNOO Admin.`
            } catch {
              await client.query("UPDATE content_factory_items SET status = 'processing', original_image_error = 'Не удалось загрузить все фото из Telegram. Повторите выбор проекта в боте; сохранённые фотографии не удалены.' WHERE id = $1 AND project_id = $2", [itemId, project.id])
              response = 'Не все фото загружены. Нажмите проект ещё раз для повтора. Сохранённые данные не удалены.'
            }
          }
        }
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      for (const file of createdFiles) await unlink(originalImagePath(file.project, file.item, file.filename)).catch(() => {})
      throw error
    }
    finally { client.release() }
    await send(response, buttons)
    return true
  }
  if (!Number.isSafeInteger(message!.message_id) || !Number.isSafeInteger(message!.date)) return true
  if (message!.video || message!.document || message!.audio || message!.voice || message!.animation || message!.sticker || !(message!.text || message!.caption || message!.photo?.length) || (message!.text?.startsWith('/') && message!.text !== '/start')) {
    await send('Отправьте текст, ссылку или фотографии с подписью. Видео, документы и голосовые сообщения не поддерживаются.')
    return true
  }
  if (message!.text === '/start') { await send('Отправьте свой материал. Для альбома дождитесь доставки всех фото, затем нажмите «Выбрать проект».'); return true }
  const key = message!.media_group_id ? `album:${message!.media_group_id}` : `message:${message!.message_id}`
  const { rows } = await pool.query<Pending>(`INSERT INTO content_factory_telegram_intake(id, sender_id, chat_id, delivery_key, messages)
    VALUES ($1,$2,$3,$4,jsonb_build_object($5::text,$6::jsonb))
    ON CONFLICT(sender_id,chat_id,delivery_key) DO UPDATE SET
      messages = CASE WHEN content_factory_telegram_intake.item_id IS NULL AND NOT (content_factory_telegram_intake.messages ? $5::text) THEN content_factory_telegram_intake.messages || EXCLUDED.messages ELSE content_factory_telegram_intake.messages END,
      updated_at = now() RETURNING *`, [randomUUID(), sender, String(message!.chat.id), key, String(message!.message_id), JSON.stringify(message)])
  const pending = rows[0]
  if (pending.item_id && !pending.messages[String(message!.message_id)]) {
    const late = await pool.query<Pending>(`INSERT INTO content_factory_telegram_intake(id,sender_id,chat_id,delivery_key,messages) VALUES ($1,$2,$3,$4,jsonb_build_object($5::text,$6::jsonb)) ON CONFLICT(sender_id,chat_id,delivery_key) DO UPDATE SET updated_at = now() RETURNING *`, [randomUUID(),sender,String(message!.chat.id),`late:${key}:${message!.message_id}`,String(message!.message_id),JSON.stringify(message)])
    await send('Фото доставлено после подтверждения альбома и сохранено отдельно. Выберите для него проект; ранее подготовленный материал не изменён.', [[{ text: 'Выбрать проект', callback_data: `cfi:${late.rows[0].id}:choose` }]])
    return true
  }
  await send(pending.completed ? 'Материал уже добавлен.' : `Собственный материал получен. Сообщений в группе: ${Object.keys(pending.messages).length}. Дождитесь всех фото, затем выберите проект.`, pending.completed ? undefined : [[{ text: 'Выбрать проект', callback_data: `cfi:${pending.id}:choose` }]])
  return true
}
