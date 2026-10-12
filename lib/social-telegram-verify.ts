// Pure Telegram Bot API calls + response parsing for verifying the shared bot can actually post
// into a given channel, split into its own file so it has zero `@/`-aliased imports and is
// directly runnable by this project's plain `node --test` (same reason lib/social-vk-verify.ts and
// lib/social-threads-text.ts are kept dependency-free, unlike the publisher files themselves).

// Not a secret — same override role as TELEGRAM_API_BASE_URL in lib/social-telegram.ts; kept as a
// separate read (not a shared import) specifically so this file stays free of `@/` imports.
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'

/** Telegram's chat_id accepts "@channelusername" or a numeric chat id — same rule
 * lib/social-telegram.ts's chatIdFor uses for the publisher, duplicated here (both are a few
 * lines) rather than importing between the two, to keep both files independently simple. */
export function normalizeTelegramChatIdentifier(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('@') || /^-?\d+$/.test(trimmed)) return trimmed
  return `@${trimmed}`
}

export type TelegramChannelIdentity = { chatId: string; title: string; username: string }
export type TelegramVerifyResult = { ok: true; identity: TelegramChannelIdentity } | { ok: false; error: string }

async function telegramGet(botToken: string, method: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params)
  let res: Response
  try {
    res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}?${qs.toString()}`)
  } catch (err) {
    throw new Error(`Could not reach Telegram API: ${err instanceof Error ? err.message : String(err)}`)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.ok) {
    throw new Error((data && typeof data.description === 'string' && data.description) || `Telegram API request failed (${res.status})`)
  }
  return data.result
}

/**
 * Verifies the shared Telegram bot (TELEGRAM_BOT_TOKEN) can actually post into the given channel —
 * requirement 2 ("проверять, что бот имеет право публиковать в выбранный канал"), not just that the
 * channel identifier looks plausible:
 *   1. getMe — the bot's own numeric user id (needed for getChatMember below).
 *   2. getChat — confirms the chat exists and is reachable, and that it really is a channel (not a
 *      private chat or a group), since the task is specifically about Telegram *channels*.
 *   3. getChatMember(chat_id, bot's user id) — confirms the bot is actually an admin/creator of
 *      that channel with posting rights. A bot that can merely see a channel (e.g. via a public
 *      username) but was never added as an admin would otherwise fail only at publish time, with a
 *      much less useful error.
 */
export async function verifyTelegramChannelAccess(botToken: string, identifierInput: string): Promise<TelegramVerifyResult> {
  const chatId = normalizeTelegramChatIdentifier(identifierInput)
  if (!chatId) return { ok: false, error: 'a channel username or chat id is required' }

  try {
    const me = await telegramGet(botToken, 'getMe', {})
    const botId = me?.id
    if (typeof botId !== 'number') return { ok: false, error: 'Telegram did not return the bot\'s own id (getMe)' }

    const chat = await telegramGet(botToken, 'getChat', { chat_id: chatId })
    if (chat?.type !== 'channel') {
      return { ok: false, error: `"${identifierInput}" is a Telegram ${chat?.type ?? 'chat'}, not a channel` }
    }

    const member = await telegramGet(botToken, 'getChatMember', { chat_id: chatId, user_id: String(botId) })
    const status = member?.status
    const canPost = status === 'creator' || (status === 'administrator' && member?.can_post_messages !== false)
    if (!canPost) {
      return {
        ok: false,
        error: `The bot is not an admin with posting rights in "${identifierInput}" (status: ${status ?? 'not a member'}) — add it as an administrator with "Post Messages" enabled`,
      }
    }

    return {
      ok: true,
      identity: {
        chatId: String(chat.id ?? chatId),
        title: typeof chat.title === 'string' ? chat.title : '',
        username: typeof chat.username === 'string' ? chat.username : '',
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
