import { timingSafeEqual } from 'node:crypto'
import { classifyTelegramBusinessUpdate } from './telegram-business-update.ts'

// Server-side only. Telegram Business intake: accepts and acknowledges a client's message to
// the connected business account, but — per Patch A — no longer turns it into a CRM lead. This
// module never calls sendMessage or any other method that writes to a chat.
//
// Patch A (CRM leads from personal Telegram Business messages, disabled): an incoming
// business_message from a private counterpart used to create/find a CRM lead, storing the
// sender's numeric id as `tg:<id>`, their display name, and their message text. That is no
// longer correct: personal Telegram Business messages must not become leads and must not have
// any of that read past classification. The update is still accepted by the webhook and
// classified (ignore / business_connection / incoming), but an `incoming` decision now always
// resolves to `{ action: 'ignored' }` — the CRM write helper is no longer imported by this file,
// and telegramUserId/displayName/firstMessage are never read past classification. See
// OLNOO_PROJECT_MAP.md → "Telegram Business intake" for the current (disabled) status.

type TelegramBusinessConfig = { token: string; secret: string; ownerUserId: string; project: string }

export function telegramBusinessConfig(): TelegramBusinessConfig | null {
  const token = process.env.TELEGRAM_BUSINESS_BOT_TOKEN?.trim()
  const secret = process.env.TELEGRAM_BUSINESS_WEBHOOK_SECRET?.trim()
  const ownerUserId = process.env.TELEGRAM_BUSINESS_OWNER_USER_ID?.trim()
  const project = process.env.TELEGRAM_BUSINESS_PROJECT?.trim()
  if (!token || !secret || !ownerUserId || !/^\d+$/.test(ownerUserId) || !project) return null
  return { token, secret, ownerUserId, project }
}

/** Constant-time check of Telegram's X-Telegram-Bot-Api-Secret-Token header. */
export function isValidWebhookSecret(provided: string | null, expected: string): boolean {
  const a = Buffer.from(provided ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type TelegramBusinessOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'connection'; enabled: boolean }

/**
 * Handles one webhook update. Throws only on a transient failure (currently none remain on the
 * `incoming` path — it no longer touches the DB or the Bot API) so the route can answer 500 and
 * Telegram redelivers safely.
 */
export async function handleTelegramBusinessUpdate(update: unknown, config: TelegramBusinessConfig): Promise<TelegramBusinessOutcome> {
  const decision = classifyTelegramBusinessUpdate(update, config.ownerUserId)

  if (decision.kind === 'ignore') return { action: 'ignored', reason: decision.reason }

  if (decision.kind === 'connection') {
    if (decision.ownerUserId !== config.ownerUserId) {
      // Anyone can attach a public bot to their own business account; such connections are inert.
      console.warn(`[tg-business] connection ${decision.connectionId} from an unexpected account is ignored`)
      return { action: 'ignored', reason: 'connection from an unexpected account' }
    }
    console.info(`[tg-business] owner connection ${decision.connectionId} is ${decision.enabled ? 'enabled' : 'disabled'}`)
    return { action: 'connection', enabled: decision.enabled }
  }

  // decision.kind === 'incoming' — Patch A: no lead is created and nothing about the sender
  // (telegram id, display name, message text) is read any further.
  return { action: 'ignored', reason: 'incoming business messages no longer create leads (disabled)' }
}
