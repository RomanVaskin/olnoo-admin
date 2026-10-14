// Pure classification of one Telegram webhook `update` object for the channel-comments feature —
// zero `@/` imports, directly runnable by this project's plain `node --test` (same reason
// lib/telegram-business-update.ts and lib/social-telegram-verify.ts are kept dependency-free).
//
// How a channel's comments actually reach a bot (confirmed against Telegram's own Bot API
// behavior, re-checked for this review pass against the current API — not the Dec-2023-or-older
// shape originally assumed): a channel's comments are NOT part of the channel itself. Enabling
// "Discussion" links the channel to a separate, ORDINARY (non-forum) supergroup — each channel
// post is auto-forwarded into that group as a message (`is_automatic_forward: true`), and the
// comment section of a post IS the message thread of that one auto-forwarded copy (per Telegram's
// own MTProto discussion-groups docs: "the comment section of a channel post is simply the
// message thread of the automatically forwarded channel message"). So:
//   1. `auto_forward` — the group's own copy of a channel post. This is how the (chat, thread)
//      pair that will later identify this post's comments gets learned in the first place.
//   2. `comment` — any other message inside an already-established thread, at any reply depth
//      (a reply to the post itself, or a reply to another comment) — Telegram keeps
//      `message_thread_id` constant for the WHOLE thread regardless of depth, so no special
//      handling is needed for "replies to replies" beyond trusting that field when present.
//
// Origin fields, since Bot API 7.0 (29 Dec 2023): `forward_from`/`forward_from_chat`/
// `forward_from_message_id`/`forward_signature`/`forward_sender_name` were replaced by one
// `forward_origin: MessageOrigin` object (Telegram keeps sending the legacy fields too, for
// backward compatibility, but new code should read `forward_origin`). For a channel post this is
// `MessageOriginChannel { type: 'channel', date, chat, message_id, author_signature? }`. Both
// shapes are read here — `forward_origin` first, the legacy fields as a fallback — so this keeps
// working however old or new the actual delivered update turns out to be.
//
// Thread-id detection does NOT assume `message_thread_id` is always present on every comment (the
// task's own instruction: never assume every group behaves like a forum topic, and don't assume
// Telegram always sets this field the same way on every message in a thread). If it's missing,
// this falls back to `reply_to_message` — a message replying directly to the thread's own
// auto-forwarded root (`reply_to_message.is_automatic_forward === true`) anchors the thread by
// that root's own `message_id`; a message replying to another comment that itself already carries
// `message_thread_id` inherits that same value. Only if neither signal is present is the message
// treated as not belonging to any known thread (`ignore`, never guessed).
//
// `message_thread_id` is only unique WITHIN one chat, never globally — so neither this file nor
// its caller may ever treat a bare thread id as identifying a post on its own; the chat id travels
// alongside it everywhere in this feature for exactly that reason. A `message_thread_id` present
// on a message in a FORUM-mode supergroup (topics enabled for reasons unrelated to channel
// comments) would be a real native topic id, not a comment-thread id — this file cannot tell the
// two apart from a single update alone, but the ambiguity is harmless downstream: the caller
// (lib/social-comments.ts's `resolveThread`) only ever matches against a (chat, thread) pair it
// already recorded from a real auto-forward event, so an unrelated topic id simply never matches
// anything and the message is dropped as unattributed — never misattributed to another project.

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

/** The channel a message was forwarded from, preferring the current `forward_origin` shape
 * (Bot API >= 7.0) and falling back to the legacy `forward_from_chat`/`forward_from_message_id`
 * fields Telegram still sends for older integrations. Returns nulls if neither shape is present
 * or the origin isn't a channel at all. */
function channelForwardOrigin(m: Record<string, unknown>): { chatId: string; chatUsername: string; messageId: string } | null {
  const origin = m.forward_origin as Record<string, unknown> | undefined
  if (origin && origin.type === 'channel') {
    const chat = origin.chat as Record<string, unknown> | undefined
    const chatId = chat && typeof chat.id === 'number' ? String(chat.id) : ''
    const chatUsername = chat && typeof chat.username === 'string' ? chat.username : ''
    const messageId = typeof origin.message_id === 'number' ? String(origin.message_id) : ''
    if (chatId && messageId) return { chatId, chatUsername, messageId }
  }

  // Legacy fallback (deprecated since Bot API 7.0, but Telegram still sends these for
  // backward-compat — never assume forward_origin is the only shape that will ever arrive).
  const forwardFromChat = m.forward_from_chat as Record<string, unknown> | undefined
  const legacyChatId = forwardFromChat && typeof forwardFromChat.id === 'number' ? String(forwardFromChat.id) : ''
  const legacyChatUsername = forwardFromChat && typeof forwardFromChat.username === 'string' ? forwardFromChat.username : ''
  const legacyMessageId = typeof m.forward_from_message_id === 'number' ? String(m.forward_from_message_id) : ''
  if (legacyChatId && legacyMessageId) return { chatId: legacyChatId, chatUsername: legacyChatUsername, messageId: legacyMessageId }

  return null
}

/** Resolves which thread a non-auto-forward message belongs to, without assuming
 * `message_thread_id` is always set: falls back to `reply_to_message` when it isn't — see the
 * file-level comment for why this is necessary and why it's still safe. */
function resolveCommentThreadId(m: Record<string, unknown>): string {
  if (typeof m.message_thread_id === 'number') return String(m.message_thread_id)

  const reply = m.reply_to_message as Record<string, unknown> | undefined
  if (reply) {
    if (typeof reply.message_thread_id === 'number') return String(reply.message_thread_id)
    if (reply.is_automatic_forward === true && typeof reply.message_id === 'number') return String(reply.message_id)
  }
  return ''
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
    const origin = channelForwardOrigin(m)
    const threadId = typeof m.message_id === 'number' ? String(m.message_id) : ''
    if (!origin || !threadId) {
      return { kind: 'ignore', reason: 'automatic forward is missing an id this feature needs' }
    }
    return {
      kind: 'auto_forward',
      discussionChatId,
      threadId,
      forwardFromChatId: origin.chatId,
      forwardFromChatUsername: origin.chatUsername,
      forwardFromMessageId: origin.messageId,
    }
  }

  const threadId = resolveCommentThreadId(m)
  if (!threadId) return { kind: 'ignore', reason: 'message is not part of any known thread' }

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
