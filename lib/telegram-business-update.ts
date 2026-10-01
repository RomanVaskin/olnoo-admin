// Pure parsing for Telegram Business webhook updates — no DB, no network, no env, so it is
// unit-testable with `node --test` (see telegram-business-update.test.ts). The I/O side lives in
// lib/telegram-business.ts. Nothing here (or there) ever sends a message: the integration only
// records incoming client messages as CRM leads; a manager replies in Telegram personally.

export type TelegramBusinessUpdateDecision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'connection'; connectionId: string; ownerUserId: string; enabled: boolean }
  | {
      kind: 'incoming'
      connectionId: string
      telegramUserId: string
      username: string
      displayName: string
      firstMessage: string
    }

const MAX_MESSAGE_LENGTH = 2000

/** The CRM dedup key stored in leads.contact — numeric id only, since a username can change. */
export function telegramContactKey(telegramUserId: string): string {
  return `tg:${telegramUserId}`
}

/**
 * Classifies one raw Telegram update. Only `business_connection` and new `business_message`
 * updates matter; edits, deletions and everything else are ignored. A business_message whose
 * sender is the connected account's owner (`ownerUserId`) is the manager's own outgoing message
 * and is ignored too — only messages from the client side can become a lead.
 */
export function classifyTelegramBusinessUpdate(update: unknown, ownerUserId: string): TelegramBusinessUpdateDecision {
  if (!isRecord(update)) return { kind: 'ignore', reason: 'not an object' }

  const connection = update.business_connection
  if (isRecord(connection)) {
    const user = isRecord(connection.user) ? connection.user : null
    const id = idString(user?.id)
    if (typeof connection.id !== 'string' || !id) return { kind: 'ignore', reason: 'malformed business_connection' }
    return { kind: 'connection', connectionId: connection.id, ownerUserId: id, enabled: connection.is_enabled === true }
  }

  const message = update.business_message
  if (!isRecord(message)) return { kind: 'ignore', reason: 'unsupported update type' }
  if (typeof message.business_connection_id !== 'string' || !message.business_connection_id) {
    return { kind: 'ignore', reason: 'business_message without business_connection_id' }
  }

  const chat = isRecord(message.chat) ? message.chat : null
  if (chat?.type !== 'private') return { kind: 'ignore', reason: 'not a private chat' }

  const from = isRecord(message.from) ? message.from : null
  const fromId = idString(from?.id)
  if (!from || !fromId) return { kind: 'ignore', reason: 'message without sender' }
  if (fromId === ownerUserId) return { kind: 'ignore', reason: 'outgoing message from the business account owner' }
  if (from.is_bot === true) return { kind: 'ignore', reason: 'message from a bot' }
  // In a business private chat the client's id is also the chat id; a mismatch means it is not
  // a plain client → business message (e.g. sent by the owner's other session or a business bot).
  if (idString(chat.id) !== fromId) return { kind: 'ignore', reason: 'sender is not the chat counterpart' }

  const username = typeof from.username === 'string' ? from.username.trim() : ''
  const fullName = [from.first_name, from.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim())
    .join(' ')

  return {
    kind: 'incoming',
    connectionId: message.business_connection_id,
    telegramUserId: fromId,
    username,
    displayName: fullName || (username ? `@${username}` : `Telegram ${fromId}`),
    firstMessage: messageText(message),
  }
}

/** The CRM `message` text for a lead created from a client's first Telegram message. */
export function telegramLeadMessage(incoming: { username: string; telegramUserId: string; firstMessage: string }): string {
  const who = incoming.username ? `@${incoming.username}` : 'без username'
  return `Прямое обращение в Telegram (${who}, id ${incoming.telegramUserId}).\nПервое сообщение: ${incoming.firstMessage}`
}

function messageText(message: Record<string, unknown>): string {
  const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : ''
  const kind = mediaKind(message)
  const body = text.trim() ? (kind ? `[${kind}] ${text.trim()}` : text.trim()) : `[${kind || 'сообщение без текста'}]`
  return body.length > MAX_MESSAGE_LENGTH ? `${body.slice(0, MAX_MESSAGE_LENGTH)}…` : body
}

const MEDIA_KINDS: Array<[string, string]> = [
  ['photo', 'фото'],
  ['video', 'видео'],
  ['video_note', 'видеосообщение'],
  ['voice', 'голосовое'],
  ['audio', 'аудио'],
  ['document', 'файл'],
  ['sticker', 'стикер'],
  ['contact', 'контакт'],
  ['location', 'геопозиция'],
]

function mediaKind(message: Record<string, unknown>): string {
  return MEDIA_KINDS.find(([key]) => message[key] !== undefined)?.[1] ?? ''
}

function idString(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
