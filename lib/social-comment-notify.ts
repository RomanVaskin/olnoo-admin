import type { TelegramCommentEvent } from './social-telegram-comments.ts'

// Server-side only. TELEGRAM_BOT_TOKEN must never be sent to the browser. Mirrors
// lib/lead-notify.ts exactly: same token/base-URL env handling, same never-throw-outward error
// handling, same injectable `send` for tests. Reuses the EXISTING admin notification channel —
// requirement 5 ("используй существующий механизм уведомлений, если он подходит") — rather than a
// new env var: `CRM_NOTIFY_TELEGRAM_CHAT_ID` is already the one chat the owner gets OLNOO Admin
// notifications in, and a new comment is exactly that kind of thing.

const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'
const ADMIN_BASE_URL = process.env.PUBLIC_SITE_URL || 'https://admin.olnoo.com'

export type ProjectInfo = { name: string; slug: string }

/** Minimal message, same style as formatLeadNotification — only non-empty fields are printed. */
export function formatCommentNotification(event: TelegramCommentEvent, project: ProjectInfo, publicationExternalUrl: string | null): string {
  const lines = [`Новый комментарий — ${project.name}`, '']
  const from = event.authorUsername ? `@${event.authorUsername}` : event.authorName
  if (from) lines.push(`От: ${from}`)
  if (event.body.trim()) lines.push(`Текст: ${event.body.trim()}`)
  if (publicationExternalUrl) lines.push('', 'Пост:', publicationExternalUrl)
  lines.push('', 'Открыть в Admin:', `${ADMIN_BASE_URL}/en?screen=social-comments&project=${project.slug}`)
  return lines.join('\n')
}

export type SendResult = { ok: true } | { error: string }
export type SendFn = (chatId: string, text: string) => Promise<SendResult>

async function sendTelegramMessage(chatId: string, text: string): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return { error: 'TELEGRAM_BOT_TOKEN is not configured' }
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.ok) {
      return { error: (data && typeof data.description === 'string' && data.description) || `Telegram API request failed (${res.status})` }
    }
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Notifies the owner on Telegram that a new channel comment was recorded. Never throws and never
 * affects the comment it follows (same contract as notifyLeadCreated) — a missing
 * CRM_NOTIFY_TELEGRAM_CHAT_ID/TELEGRAM_BOT_TOKEN, or a Telegram API error, is logged and
 * swallowed; the comment row this follows was already committed by the caller before this runs,
 * so a notification failure never loses or risks the already-received comment (requirement:
 * "ошибка Telegram API не приводит к потере уже полученных комментариев").
 */
export async function notifyNewComment(
  event: TelegramCommentEvent,
  project: ProjectInfo,
  publicationExternalUrl: string | null,
  send: SendFn = sendTelegramMessage,
): Promise<void> {
  const chatId = process.env.CRM_NOTIFY_TELEGRAM_CHAT_ID
  if (!chatId) {
    console.warn('[comment-notify] CRM_NOTIFY_TELEGRAM_CHAT_ID is not configured — skipping comment notification')
    return
  }
  try {
    const result = await send(chatId, formatCommentNotification(event, project, publicationExternalUrl))
    if ('error' in result) {
      console.error('[comment-notify] failed to send Telegram notification:', result.error)
    }
  } catch (err) {
    console.error('[comment-notify] failed to send Telegram notification:', err instanceof Error ? err.message : String(err))
  }
}
