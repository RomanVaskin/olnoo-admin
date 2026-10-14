// Pure classification of one Telegram webhook `update` object for the channel-comments feature —
// zero `@/` imports, directly runnable by this project's plain `node --test` (same reason
// lib/telegram-business-update.ts and lib/social-telegram-verify.ts are kept dependency-free).
//
// How a channel's comments actually reach a bot (confirmed against Telegram's own Bot API
// behavior before writing this, per this task's own instruction not to assume): a channel's
// comments are NOT part of the channel itself. They live in a separate, LINKED discussion
// supergroup — each channel post is auto-forwarded into that group as an ordinary message
// (`is_automatic_forward: true`, `forward_from_chat` = the channel, `forward_from_message_id` =
// that post's own id in the channel), and every viewer comment is a plain `message` in that same
// group with `message_thread_id` set to the auto-forwarded message's own `message_id` (the thread
// root). So this file recognizes exactly two kinds of incoming `message` update, and ignores
// everything else (edits, non-text updates, messages with no thread at all, the bot's own
// messages):
//   1. `auto_forward` — the group's own copy of a channel post. This is how the (chat, thread)
//      pair that will later identify this post's comments gets learned in the first place.
//   2. `comment` — a reply inside an already-established thread.
//
// `message_thread_id` is only unique WITHIN one chat, never globally — so neither this file nor
// its caller may ever treat a bare thread id as identifying a post on its own; the chat id travels
// alongside it everywhere in this feature for exactly that reason.

export type TelegramAutoForwardEvent = {
  kind: 'auto_forward'
  discussionChatId: string
  threadId: string
  forwardFromChatId: string
  /** Without the leading "@" — empty if the channel has no public username. */
  forwardFromChatUsername: string
  forwardFromMessageId: string
}

export type TelegramCommentEvent = {
  kind: 'comment'
  discussionChatId: string
  threadId: string
  externalCommentId: string
  authorName: string
  authorUsername: string
  body: string
  postedAt: Date
}

export type TelegramCommentsUpdateDecision =
  | TelegramAutoForwardEvent
  | TelegramCommentEvent
  | { kind: 'ignore'; reason: string }

function displayName(from: { first_name?: unknown; last_name?: unknown } | undefined): string {
  if (!from) return ''
  const first = typeof from.first_name === 'string' ? from.first_name : ''
  const last = typeof from.last_name === 'string' ? from.last_name : ''
  return [first, last].filter(Boolean).join(' ').trim()
}

export function classifyTelegramCommentsUpdate(update: unknown): TelegramCommentsUpdateDecision {
  if (!update || typeof update !== 'object') return { kind: 'ignore', reason: 'not an object' }
  const message = (update as { message?: unknown }).message
  if (!message || typeof message !== 'object') {
    // edited_message, channel_post, callback_query, … — none of this feature's concern.
    return { kind: 'ignore', reason: 'not a plain message update' }
  }
  const m = message as Record<string, unknown>

  const chat = m.chat as Record<string, unknown> | undefined
  if (chat?.type !== 'supergroup') {
    // Comments only ever arrive in the linked discussion group, which Telegram always types as a
    // supergroup — a message straight in the channel, or in an unrelated chat, is never a comment.
    return { kind: 'ignore', reason: 'not a supergroup message' }
  }
  const discussionChatId = typeof chat.id === 'number' ? String(chat.id) : ''
  if (!discussionChatId) return { kind: 'ignore', reason: 'chat has no id' }

  const from = m.from as Record<string, unknown> | undefined
  if (from?.is_bot === true) return { kind: 'ignore', reason: 'message is from a bot' }

  if (m.is_automatic_forward === true) {
    const forwardFromChat = m.forward_from_chat as Record<string, unknown> | undefined
    const forwardFromChatId = forwardFromChat && typeof forwardFromChat.id === 'number' ? String(forwardFromChat.id) : ''
    const forwardFromChatUsername =
      forwardFromChat && typeof forwardFromChat.username === 'string' ? forwardFromChat.username : ''
    const forwardFromMessageId = typeof m.forward_from_message_id === 'number' ? String(m.forward_from_message_id) : ''
    const threadId = typeof m.message_id === 'number' ? String(m.message_id) : ''
    if (!forwardFromChatId || !forwardFromMessageId || !threadId) {
      return { kind: 'ignore', reason: 'automatic forward is missing an id this feature needs' }
    }
    return { kind: 'auto_forward', discussionChatId, threadId, forwardFromChatId, forwardFromChatUsername, forwardFromMessageId }
  }

  const threadId = typeof m.message_thread_id === 'number' ? String(m.message_thread_id) : ''
  if (!threadId) return { kind: 'ignore', reason: 'message is not part of any thread' }

  const externalCommentId = typeof m.message_id === 'number' ? String(m.message_id) : ''
  if (!externalCommentId) return { kind: 'ignore', reason: 'message has no id' }
  const dateSeconds = typeof m.date === 'number' ? m.date : null
  if (dateSeconds === null) return { kind: 'ignore', reason: 'message has no date' }

  const text = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : ''
  return {
    kind: 'comment',
    discussionChatId,
    threadId,
    externalCommentId,
    authorName: displayName(from),
    authorUsername: from && typeof from.username === 'string' ? from.username : '',
    body: text,
    postedAt: new Date(dateSeconds * 1000),
  }
}
