import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { handleTelegramCommentsUpdate, type TelegramCommentsDeps } from '@/lib/telegram-comments-handler'
import {
  linkAutoForward,
  resolveThread,
  insertCommentIfNew,
  markCommentNotified,
  listUnnotifiedComments,
} from '@/lib/social-comments'
import { notifyNewComment } from '@/lib/social-comment-notify'
import type { TelegramCommentEvent } from '@/lib/social-telegram-comments'

export const runtime = 'nodejs'

// Telegram webhook for the EXISTING, already-live posting bot (TELEGRAM_BOT_TOKEN) — registered
// once by hand with setWebhook + secret_token (see OLNOO_PROJECT_MAP.md's "Social Community —
// Telegram channel comments" → "Manual KZ install steps"), same pattern as
// app/api/telegram/business-webhook/route.ts, but for a DIFFERENT bot token's webhook slot:
// TELEGRAM_BOT_TOKEN had no webhook and no getUpdates polling registered anywhere before this
// (confirmed by reading every existing use of it — only outbound sendMessage/getChat/
// getChatMember calls), so this is the first and only webhook for it — see that same doc section
// for why webhook was chosen over polling (getUpdates and setWebhook are mutually exclusive per
// bot, and getUpdates has no safe way to have more than one independent consumer without losing
// events — a webhook has neither problem).
//
// Never replies into the discussion group: no Bot API method that writes to a chat is called
// anywhere in this flow. The owner's own Telegram notification for a new comment is sent entirely
// by notifyNewComment below.

async function projectInfoFor(projectId: number): Promise<{ name: string; slug: string } | null> {
  const { rows } = await pool.query<{ name: string; slug: string }>('SELECT name, slug FROM projects WHERE id = $1', [projectId])
  return rows[0] ?? null
}

async function publicationUrlForThread(discussionChatId: string, threadId: string): Promise<string | null> {
  const { rows } = await pool.query<{ external_url: string }>(
    `SELECT sp.external_url FROM social_publications sp
     WHERE sp.telegram_discussion_chat_id = $1 AND sp.telegram_discussion_thread_id = $2`,
    [discussionChatId, threadId],
  )
  return rows[0]?.external_url || null
}

const deps: TelegramCommentsDeps = {
  linkAutoForward: (event) => linkAutoForward(pool, event),
  resolveThread: (chatId, threadId, event) => resolveThread(pool, chatId, threadId, event),
  insertCommentIfNew: (projectId, publicationId, event) => insertCommentIfNew(pool, projectId, publicationId, event),
  // Only ever marks the comment notified once the send itself reports success — a failed/
  // unconfigured attempt leaves `notified_at` NULL so retryUnnotifiedComments below (run at the
  // end of every webhook call) picks it up later. Never throws past this point: notifyNewComment
  // itself already swallows every failure (see lib/social-comment-notify.ts).
  notifyNewComment: async (projectId, commentId, event) => {
    const project = await projectInfoFor(projectId)
    if (!project) return // project was deleted between the insert and here — nothing sensible to notify
    const publicationExternalUrl = await publicationUrlForThread(event.discussionChatId, event.threadId)
    const result = await notifyNewComment(event, project, publicationExternalUrl)
    if ('ok' in result) await markCommentNotified(pool, commentId)
  },
}

/**
 * Minimal fix for "a comment that is saved must not silently lose its notification forever on a
 * transient Telegram error" (requirement: no separate queue/service) — a bounded, best-effort
 * retry of a few comments `social_comments.notified_at IS NULL` long enough ago that their
 * original attempt has clearly already happened, run once at the end of every webhook call. This
 * piggybacks on traffic the webhook already receives rather than adding a new timer; see
 * lib/social-comments.ts's `listUnnotifiedComments` for the one known limitation (a totally
 * silent channel never retries on its own) and why that's an acceptable trade-off here.
 */
async function retryUnnotifiedComments(): Promise<void> {
  try {
    const pending = await listUnnotifiedComments(pool, 2 * 60 * 1000)
    for (const comment of pending) {
      const event: TelegramCommentEvent = {
        kind: 'comment',
        discussionChatId: '',
        threadId: '',
        externalCommentId: comment.id,
        authorName: comment.authorName,
        authorUsername: comment.authorUsername,
        body: comment.body,
        postedAt: new Date(comment.externalPostedAt ?? comment.createdAt),
      }
      const result = await notifyNewComment(event, { name: comment.projectName, slug: comment.projectSlug }, comment.publicationExternalUrl)
      if ('ok' in result) await markCommentNotified(pool, comment.id)
    }
  } catch (err) {
    // Best-effort only — never lets a retry-sweep failure turn an otherwise-successful webhook
    // call into a 500 (which would make Telegram redeliver an update that was already handled).
    console.error('[tg-comments] retry sweep failed:', err instanceof Error ? err.message : err)
  }
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
    await retryUnnotifiedComments()
    return NextResponse.json({ ok: true, ...outcome })
  } catch (error) {
    // Transient (DB/network) failure — 500 makes Telegram redeliver this exact update later;
    // insertCommentIfNew's dedup means a successful redelivery can never create a duplicate, and
    // nothing already committed by a PRIOR, different update is ever touched by this failure.
    console.error('[tg-comments] update failed:', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'temporary failure' }, { status: 500 })
  }
}
