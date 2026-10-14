import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { callAiRouter, AiRouterError } from './ai-router.ts'

// Social Community: AI-suggested replies to Telegram channel comments (MVP). `pool` is injected
// by the caller (app/api/social-comments/[id]/suggest-reply, send-reply routes) — same convention
// as lib/social-comments.ts, so this is directly testable under `node --test` against a real (or
// gracefully-skipped) Postgres.
//
// Project isolation: every query below is scoped by `project_id` taken from the resolved project
// slug on the server side (never from the client) — a comment id from another project resolves as
// not-found, same guarantee as every other Social module endpoint.
//
// No new AI provider, no new Telegram bot: `callAiRouter` (lib/ai-router.ts) is the SAME OLNOO AI
// Router client lib/social-ai.ts already uses for post-variant generation; the actual send below
// reuses TELEGRAM_BOT_TOKEN/TELEGRAM_API_BASE_URL, the same env vars lib/social-telegram.ts and
// lib/social-comment-notify.ts already read — no new env var anywhere in this file.

const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'

// Same bound as lib/social-telegram.ts's own SEND_TIMEOUT_MS, for the same reason: only this one
// irreversible call gets a timeout, so a hung request is eventually treated as an unconfirmable
// ("unknown") outcome rather than left to hang indefinitely.
const SEND_TIMEOUT_MS = 20_000

export type ReplyStatus = 'sending' | 'sent' | 'failed'

export type CommentReplyRow = {
  id: string
  status: ReplyStatus
  body: string
  externalReplyMessageId: string
  error: string
}

function rowToReply(row: { id: string; status: string; body: string; external_reply_message_id: string; error: string }): CommentReplyRow {
  return {
    id: row.id,
    status: row.status as ReplyStatus,
    body: row.body,
    externalReplyMessageId: row.external_reply_message_id,
    error: row.error,
  }
}

export type CommentReplyContext = {
  commentId: string
  projectId: number
  commentBody: string
  commentAuthorLabel: string
  postText: string
  /** The Telegram discussion-group chat id this comment's thread was observed in
   * (`social_publications.telegram_discussion_chat_id`) — empty if the comment's publication row
   * was deleted after the comment was recorded (`social_publication_id` is `ON DELETE SET NULL`),
   * a narrow edge case that simply makes this comment un-reply-able (nothing to reply into), never
   * guessed at. */
  discussionChatId: string
  /** The comment's own Telegram message id within that chat — the exact `reply_to_message_id`
   * requirement 6 asks for. */
  externalCommentId: string
  existingReply: CommentReplyRow | null
}

/**
 * Fetches everything needed to suggest or send a reply to one comment, scoped to `projectId` —
 * returns `null` if the comment doesn't exist or belongs to a different project (never guessed,
 * never cross-project). Also returns any already-recorded reply attempt for this comment (there is
 * at most one — see db/migrations/0026_social_comment_replies.sql), so a caller can tell "nothing
 * sent yet" apart from "already sent/failed/unresolved" without a second round trip.
 */
export async function getCommentForReply(pool: Pool, projectId: number, commentId: string): Promise<CommentReplyContext | null> {
  const { rows } = await pool.query<{
    id: string
    comment_body: string
    author_name: string
    author_username: string
    external_comment_id: string
    discussion_chat_id: string | null
    telegram_text: string | null
    post_body: string | null
  }>(
    `SELECT c.id, c.body AS comment_body, c.author_name, c.author_username, c.external_comment_id,
            sp.telegram_discussion_chat_id AS discussion_chat_id,
            spost.telegram_text, spost.body AS post_body
     FROM social_comments c
     LEFT JOIN social_publications sp ON sp.id = c.social_publication_id
     LEFT JOIN social_posts spost ON spost.id = sp.social_post_id
     WHERE c.id = $1 AND c.project_id = $2`,
    [commentId, projectId],
  )
  const row = rows[0]
  if (!row) return null

  const { rows: replyRows } = await pool.query<{
    id: string
    status: string
    body: string
    external_reply_message_id: string
    error: string
  }>(
    `SELECT id, status, body, external_reply_message_id, error
     FROM social_comment_replies
     WHERE social_comment_id = $1 AND project_id = $2`,
    [commentId, projectId],
  )

  return {
    commentId: row.id,
    projectId,
    commentBody: row.comment_body,
    commentAuthorLabel: row.author_username ? `@${row.author_username}` : row.author_name,
    postText: row.telegram_text?.trim() || row.post_body?.trim() || '',
    discussionChatId: row.discussion_chat_id || '',
    externalCommentId: row.external_comment_id,
    existingReply: replyRows[0] ? rowToReply(replyRows[0]) : null,
  }
}

// --- AI suggestion ------------------------------------------------------------------------------

const COMMENT_REPLY_SYSTEM_PROMPT = `You are the community manager replying, on behalf of the channel, to ONE viewer comment left under a Telegram channel post.

Hard rules:
1. Base your reply ONLY on ORIGINAL POST and COMMENT below — never invent facts, prices, discounts, dates, promises, or results that are not present in either.
2. Keep it short and natural — one or two sentences, the way a real person actually replies to a comment. Never a sales pitch, never a generic corporate tone.
3. Write the reply in the SAME language as COMMENT (its own detected language is given as COMMENT LANGUAGE) — never translate, and never switch languages even if ORIGINAL POST happens to be in a different one.
4. Return ONLY the reply text itself — no markdown, no surrounding quotes, no "Reply:" label, no commentary before or after. The raw response is used as the reply text directly.`

/** Same minimal Cyrillic-presence heuristic as lib/social-ai.ts's own detectContentLanguage,
 * applied to the COMMENT instead of the post — the reply must match what the commenter actually
 * wrote, not the language the original post happened to be published in. */
function detectCommentLanguage(text: string): 'ru' | 'en' {
  return /[а-яё]/i.test(text) ? 'ru' : 'en'
}

function buildReplyPrompt(input: { postText: string; commentBody: string; commentAuthorLabel: string; language: 'ru' | 'en'; projectContext: string }): string {
  return `ORIGINAL POST:
${input.postText || '(not available)'}

COMMENT (from ${input.commentAuthorLabel || 'a viewer'}):
${input.commentBody}

COMMENT LANGUAGE: ${input.language}

PROJECT CONTEXT: ${input.projectContext || '(none given)'}

Write ONE short, natural reply to COMMENT, in COMMENT LANGUAGE.`
}

export type SuggestCommentReplyResult = { error: string; status: number } | { reply: string }

/**
 * Asks the existing OLNOO AI Router (same client as lib/social-ai.ts) to suggest one reply to a
 * comment, given the comment itself and its original post as context. Read-only — never writes
 * anything, never sends anything; the caller (the "Предложить ответ" / "Сгенерировать заново"
 * actions) decides what happens to the returned text, which is never persisted until a human
 * explicitly sends it via `sendCommentReply`.
 *
 * Returns a result object (never throws) — same style as `sendCommentReply` below — so the route
 * can tell "comment not found" (404) apart from "the AI Router failed" (422) without inspecting
 * error messages.
 */
export async function suggestCommentReply(pool: Pool, projectId: number, commentId: string): Promise<SuggestCommentReplyResult> {
  const context = await getCommentForReply(pool, projectId, commentId)
  if (!context) return { error: 'not found', status: 404 }
  if (!context.commentBody.trim()) return { error: 'this comment has no text to reply to', status: 400 }

  const { rows } = await pool.query<{ name: string; domain: string }>('SELECT name, domain FROM projects WHERE id = $1', [projectId])
  const project = rows[0]
  const projectContext = project ? `${project.name} (${project.domain})` : ''

  let content: string
  try {
    content = await callAiRouter(
      [
        { role: 'system', content: COMMENT_REPLY_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildReplyPrompt({
            postText: context.postText,
            commentBody: context.commentBody,
            commentAuthorLabel: context.commentAuthorLabel,
            language: detectCommentLanguage(context.commentBody),
            projectContext,
          }),
        },
      ],
      { temperature: 0.4, task: 'social-comment-reply-suggestion' },
    )
  } catch (err) {
    const message = err instanceof AiRouterError ? err.message : err instanceof Error ? err.message : String(err)
    return { error: message, status: 422 }
  }

  const text = content.trim()
  if (!text) return { error: 'AI Router returned an empty reply.', status: 422 }
  return { reply: text }
}

// --- Sending the confirmed reply -----------------------------------------------------------------

export type SendCommentReplyResult = { error: string; status: number } | { row: CommentReplyRow }

/**
 * Sends `text` (the human-confirmed, possibly hand-edited reply) as an actual Telegram reply to
 * the comment's own message, in the SAME discussion group it arrived in — `reply_to_message_id`
 * is the comment's own `external_comment_id` (requirement 6).
 *
 * No automatic send ever happens anywhere in this file — this is only ever called after a human
 * clicks "Отправить" in the UI.
 *
 * Never sends twice, including under a double click or two concurrent requests: right before the
 * Telegram call, this atomically claims the ONE row this comment is ever allowed to have in
 * `social_comment_replies` via `INSERT ... ON CONFLICT (social_comment_id) DO NOTHING` — see that
 * migration's own comment for the full argument. Only the caller that wins the insert ever reaches
 * the Telegram call; every other caller is refused with 409 before any Telegram API call is made.
 *
 * A definitive Telegram rejection (a response was received, just not success) is written as
 * `status = 'failed'` with the error — a later retry is simply calling this again... except it
 * can't: the UNIQUE index means a `'failed'` row can never be retried through this same function.
 * This mirrors the Publisher's own "no automatic retry" posture (see
 * lib/social-publication-claim.ts) one level down — correcting a failed reply means handling it
 * directly in Telegram, not through this MVP.
 *
 * A send whose outcome is genuinely UNKNOWN (the fetch() never got a response at all — a timeout,
 * a dropped connection) is deliberately NOT written as `'failed'`: the row is left at `'sending'`
 * (requirement 8 — never auto-retried; the UNIQUE index guarantees nothing else ever can be,
 * either) and a 503 is returned so only a human who has checked Telegram directly can resolve it.
 */
export async function sendCommentReply(pool: Pool, projectId: number, commentId: string, text: string): Promise<SendCommentReplyResult> {
  const trimmed = text.trim()
  if (!trimmed) return { error: 'reply text is required', status: 400 }

  const context = await getCommentForReply(pool, projectId, commentId)
  if (!context) return { error: 'not found', status: 404 }
  if (!context.discussionChatId || !context.externalCommentId) {
    return { error: 'this comment has no discussion thread to reply into', status: 400 }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return { error: 'TELEGRAM_BOT_TOKEN is not configured on the server', status: 500 }

  const id = randomUUID()
  const { rows: claimedRows } = await pool.query<{ id: string }>(
    `INSERT INTO social_comment_replies (id, project_id, social_comment_id, status, body)
     VALUES ($1, $2, $3, 'sending', $4)
     ON CONFLICT (social_comment_id) DO NOTHING
     RETURNING id`,
    [id, projectId, commentId, trimmed],
  )
  if (!claimedRows[0]) {
    const { rows: existingRows } = await pool.query<{ status: string }>(
      'SELECT status FROM social_comment_replies WHERE social_comment_id = $1 AND project_id = $2',
      [commentId, projectId],
    )
    const status = existingRows[0]?.status
    if (status === 'sent') return { error: 'a reply has already been sent for this comment', status: 409 }
    return {
      error: 'a reply attempt is already in progress or unresolved for this comment — check Telegram directly before retrying',
      status: 409,
    }
  }

  let telegramError: string | null = null
  let replyMessageId: number | null = null
  let sendOutcomeUnknown = false
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: context.discussionChatId,
        text: trimmed,
        reply_to_message_id: Number(context.externalCommentId),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    // Same reasoning as lib/social-telegram.ts's own send: a 2xx with an unreadable body is NOT a
    // confirmed failure (it strongly suggests Telegram accepted it), only a non-2xx is.
    let data: unknown = null
    let bodyReadFailed = false
    try {
      data = await res.json()
    } catch {
      bodyReadFailed = true
    }
    if (res.ok && bodyReadFailed) {
      telegramError = 'Telegram returned a success status but the response body could not be read'
      sendOutcomeUnknown = true
    } else if (!res.ok || !(data as { ok?: boolean } | null)?.ok) {
      const errorData = data as { description?: unknown } | null
      telegramError = (errorData && typeof errorData.description === 'string' && errorData.description) || `Telegram API request failed (${res.status})`
    } else {
      replyMessageId = (data as { result?: { message_id?: number } }).result?.message_id ?? null
    }
  } catch (err) {
    // fetch() itself threw — Telegram never answered, so the reply may or may not have actually
    // gone out. Not a confirmed failure.
    telegramError = err instanceof Error ? err.message : String(err)
    sendOutcomeUnknown = true
  }

  if (sendOutcomeUnknown) {
    // Deliberately no status write — the row stays 'sending' (requirement 8: never auto-retried;
    // the UNIQUE index on social_comment_id also means nothing else can ever retry through this
    // function either — only a human resolving it directly in Telegram can move this forward).
    return {
      error: `Could not confirm whether Telegram received the reply: ${telegramError}. Status left as "sending" — check Telegram directly before anything further.`,
      status: 503,
    }
  }

  if (telegramError || !replyMessageId) {
    const { rows } = await pool.query<{ id: string; status: string; body: string; external_reply_message_id: string; error: string }>(
      `UPDATE social_comment_replies SET status = 'failed', error = $1, updated_at = now() WHERE id = $2
       RETURNING id, status, body, external_reply_message_id, error`,
      [telegramError || 'Telegram did not return a message id', id],
    )
    return { row: rowToReply(rows[0]) }
  }

  const { rows } = await pool.query<{ id: string; status: string; body: string; external_reply_message_id: string; error: string }>(
    `UPDATE social_comment_replies SET status = 'sent', external_reply_message_id = $1, error = '', updated_at = now() WHERE id = $2
     RETURNING id, status, body, external_reply_message_id, error`,
    [String(replyMessageId), id],
  )
  return { row: rowToReply(rows[0]) }
}
