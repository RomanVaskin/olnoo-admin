import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { handleTelegramCommentsUpdate, type TelegramCommentsDeps } from '@/lib/telegram-comments-handler'
import { linkAutoForward, resolveThread, insertCommentIfNew } from '@/lib/social-comments'
import { notifyNewComment } from '@/lib/social-comment-notify'

export const runtime = 'nodejs'

// Telegram webhook for the EXISTING, already-live posting bot (TELEGRAM_BOT_TOKEN) — registered
// once by hand with setWebhook + secret_token (see deploy/social-comments-webhook/README.md),
// same pattern as app/api/telegram/business-webhook/route.ts, but for a DIFFERENT bot token's
// webhook slot: TELEGRAM_BOT_TOKEN had no webhook and no getUpdates polling registered anywhere
// before this (confirmed by reading every existing use of it — only outbound sendMessage/getChat/
// getChatMember calls), so this is the first and only webhook for it; see OLNOO_PROJECT_MAP.md's
// "Social Community — Telegram channel comments" for why webhook was chosen over polling
// (getUpdates and setWebhook are mutually exclusive per bot, and getUpdates has no safe way to
// have more than one independent consumer without losing events — a webhook has neither problem).
//
// Never replies into the discussion group: no Bot API method that writes to a chat is called
// anywhere in this flow. The owner's own Telegram notification for a new comment is sent entirely
// by notifyNewComment below.
const deps: TelegramCommentsDeps = {
  linkAutoForward: (event) => linkAutoForward(pool, event),
  resolveThread: (chatId, threadId) => resolveThread(pool, chatId, threadId),
  insertCommentIfNew: (projectId, publicationId, event) => insertCommentIfNew(pool, projectId, publicationId, event),
  notifyNewComment: async (projectId, _commentId, event) => {
    const [{ rows: projectRows }, { rows: pubRows }] = await Promise.all([
      pool.query<{ name: string; slug: string }>('SELECT name, slug FROM projects WHERE id = $1', [projectId]),
      pool.query<{ external_url: string }>(
        `SELECT sp.external_url FROM social_publications sp
         WHERE sp.telegram_discussion_chat_id = $1 AND sp.telegram_discussion_thread_id = $2`,
        [event.discussionChatId, event.threadId],
      ),
    ])
    const project = projectRows[0]
    if (!project) return // project was deleted between the insert and here — nothing sensible to notify
    await notifyNewComment(event, project, pubRows[0]?.external_url || null)
  },
}

/** Constant-time check of Telegram's X-Telegram-Bot-Api-Secret-Token header — same helper as
 * lib/telegram-business.ts's isValidWebhookSecret, duplicated rather than imported (both are a
 * few lines; keeping each webhook route's auth self-contained, same convention as
 * normalizeTelegramChatIdentifier being duplicated between social-telegram.ts and
 * social-telegram-verify.ts). */
function isValidWebhookSecret(provided: string | null, expected: string): boolean {
  const a = Buffer.from(provided ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_COMMENTS_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Telegram comments intake is not configured' }, { status: 503 })
  }
  if (!isValidWebhookSecret(req.headers.get('x-telegram-bot-api-secret-token'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const update = await req.json().catch(() => null)
  try {
    const outcome = await handleTelegramCommentsUpdate(update, deps)
    return NextResponse.json({ ok: true, ...outcome })
  } catch (error) {
    // Transient (DB/network) failure — 500 makes Telegram redeliver this exact update later;
    // insertCommentIfNew's dedup means a successful redelivery can never create a duplicate, and
    // nothing already committed by a PRIOR, different update is ever touched by this failure.
    console.error('[tg-comments] update failed:', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'temporary failure' }, { status: 500 })
  }
}
