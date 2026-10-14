import {
  classifyTelegramCommentsUpdate,
  type TelegramAutoForwardEvent,
  type TelegramCommentEvent,
} from './social-telegram-comments.ts'

// Server-side orchestration for one Telegram webhook update, kept free of `@/` imports (same
// reason lib/telegram-business.ts is) so it runs directly under `node --test` with fake deps —
// the real DB-backed implementations (lib/social-comments.ts) and the real notifier
// (lib/social-comment-notify.ts) are injected by app/api/telegram/comments-webhook/route.ts, the
// only place that wires `@/lib/db` in.
//
// Project isolation, deduplication and "notify exactly once" are decided HERE, not scattered
// across the DB layer or the route: every comment this function ever reports as newly recorded
// came from exactly one successful `insertCommentIfNew` call, and the notifier is only ever
// called immediately after that — never for a redelivered/duplicate update, never for a comment
// whose thread (and therefore project) couldn't be resolved.

export type TelegramCommentsDeps = {
  /** An automatic-forward event means a channel post just appeared in its discussion group.
   * Resolves which project owns that channel (via the project's own already-verified Telegram
   * connection) and which `social_publications` row this is the auto-forwarded copy of (matching
   * `forwardFromMessageId` against that row's `external_post_id`), then persists the (chat,
   * thread) pair onto that one row so later comments in this thread can be attributed. Returns
   * `null` if the channel isn't a known, connected project's channel, or no publication matches —
   * never guessed. Idempotent: redelivering the same auto-forward event is a no-op the second
   * time (the row already has this exact thread). */
  linkAutoForward: (event: TelegramAutoForwardEvent) => Promise<{ projectId: number; publicationId: string } | null>
  /** Resolves a comment's (discussionChatId, threadId) pair to the project/publication a PRIOR
   * `linkAutoForward` call already recorded for it. `threadId` alone is never looked up without
   * `discussionChatId` — thread ids are only unique within one chat. Returns `null` if this
   * thread was never linked (the comment arrived before, or without, its own post ever being
   * observed as an automatic forward) — NOT dropped: the real implementation (lib/social-comments.ts)
   * remembers `event` so it can be replayed the moment the thread does link, since arriving this
   * early is a real race, not only a hypothetical one (see db/migrations/0025_social_telegram_pending_comments.sql). */
  resolveThread: (discussionChatId: string, threadId: string, event: TelegramCommentEvent) => Promise<{ projectId: number; publicationId: string } | null>
  /** Inserts the comment keyed by (projectId, platform, externalCommentId) — a second call with
   * the same id (webhook redelivery, or this handler retried after a transient failure) reports
   * `inserted: false` rather than creating a second row or re-triggering notification. */
  insertCommentIfNew: (
    projectId: number,
    publicationId: string,
    event: TelegramCommentEvent,
  ) => Promise<{ inserted: true; commentId: string } | { inserted: false }>
  /** Fire-and-forget — must never throw (same contract as lib/lead-notify.ts's notifyLeadCreated).
   * Called at most once per genuinely new comment, right after insertCommentIfNew reports
   * `inserted: true`. */
  notifyNewComment: (projectId: number, commentId: string, event: TelegramCommentEvent) => Promise<void>
}

export type TelegramCommentsOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'thread_linked'; projectId: number; publicationId: string }
  | { action: 'thread_unknown' }
  | { action: 'comment_unattributed' }
  | { action: 'comment_recorded'; projectId: number; commentId: string }
  | { action: 'comment_duplicate' }

export async function handleTelegramCommentsUpdate(update: unknown, deps: TelegramCommentsDeps): Promise<TelegramCommentsOutcome> {
  const decision = classifyTelegramCommentsUpdate(update)
  if (decision.kind === 'ignore') return { action: 'ignored', reason: decision.reason }

  if (decision.kind === 'auto_forward') {
    const linked = await deps.linkAutoForward(decision)
    if (!linked) return { action: 'thread_unknown' }
    return { action: 'thread_linked', projectId: linked.projectId, publicationId: linked.publicationId }
  }

  // decision.kind === 'comment'
  const resolved = await deps.resolveThread(decision.discussionChatId, decision.threadId, decision)
  if (!resolved) return { action: 'comment_unattributed' }

  const result = await deps.insertCommentIfNew(resolved.projectId, resolved.publicationId, decision)
  if (!result.inserted) return { action: 'comment_duplicate' }

  await deps.notifyNewComment(resolved.projectId, result.commentId, decision)
  return { action: 'comment_recorded', projectId: resolved.projectId, commentId: result.commentId }
}
