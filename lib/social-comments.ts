import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { normalizeTelegramChatIdentifier } from './social-telegram-verify.ts'
import type { TelegramAutoForwardEvent, TelegramCommentEvent } from './social-telegram-comments.ts'

// No `@/` imports — `pool` is passed in by the caller, same convention as
// lib/social-publication-claim.ts / lib/social-scheduler-lock.ts — so this is directly testable
// under `node --test` against a real (or gracefully-skipped) Postgres. The real pool is wired in
// by app/api/telegram/comments-webhook/route.ts and app/api/social-comments/route.ts.
//
// Project isolation here rests entirely on TWO existing, already-verified facts, never a new
// per-client registry: (1) `social_accounts.username` is the project's own real Telegram channel
// identity, confirmed via the Bot API when the account was connected (see "Telegram channel
// connection" in OLNOO_PROJECT_MAP.md); (2) `social_publications.external_post_id` is the exact
// Telegram message id the channel post was published with (lib/social-telegram.ts). A channel
// post's automatic-forward event carries both the channel's own identity AND that same message
// id, so matching against these two existing columns — never a new per-client mapping table —
// is enough to say which project a discussion thread belongs to.

export type ThreadMatch = { projectId: number; publicationId: string }

/**
 * An automatic-forward event means a channel post just appeared in its linked discussion group.
 * Resolves the one project whose connected Telegram channel matches `forwardFromChatId`/
 * `forwardFromChatUsername` AND whose `social_publications` row has `external_post_id =
 * forwardFromMessageId` within THAT project — never across projects, since the join below is
 * scoped by the matched account's own `project_id`. Returns `null` (never guessed) if no
 * connected project's channel matches, or no publication matches within it (e.g. a post made
 * directly in the channel, outside OLNOO Admin's own publish flow).
 *
 * Idempotent: if the matched publication already carries this EXACT (chat, thread) pair, the
 * UPDATE is a harmless no-op (redelivery of the same auto-forward event); if it already carries a
 * DIFFERENT one, the existing mapping is left alone rather than silently overwritten — the match
 * is still reported, since the project/publication identity doesn't depend on which mapping won.
 */
export async function linkAutoForward(pool: Pool, event: TelegramAutoForwardEvent): Promise<ThreadMatch | null> {
  const candidates = [
    event.forwardFromChatUsername ? normalizeTelegramChatIdentifier(event.forwardFromChatUsername) : null,
    event.forwardFromChatId,
  ].filter((v): v is string => !!v)
  if (!candidates.length) return null

  const { rows } = await pool.query<{ project_id: number; publication_id: string }>(
    `SELECT sa.project_id AS project_id, sp.id AS publication_id
     FROM social_accounts sa
     JOIN social_publications sp ON sp.project_id = sa.project_id AND sp.platform = 'telegram' AND sp.external_post_id = $1
     WHERE sa.platform = 'telegram' AND sa.active = true AND lower(sa.username) = ANY($2)
     LIMIT 1`,
    [event.forwardFromMessageId, candidates.map((c) => c.toLowerCase())],
  )
  const match = rows[0]
  if (!match) return null

  await pool.query(
    `UPDATE social_publications
     SET telegram_discussion_chat_id = $1, telegram_discussion_thread_id = $2, updated_at = now()
     WHERE id = $3 AND project_id = $4
       AND (telegram_discussion_thread_id = '' OR (telegram_discussion_chat_id = $1 AND telegram_discussion_thread_id = $2))`,
    [event.discussionChatId, event.threadId, match.publication_id, match.project_id],
  )
  return { projectId: match.project_id, publicationId: match.publication_id }
}

/** Resolves a comment's (discussionChatId, threadId) pair to the project/publication a prior
 * `linkAutoForward` call recorded for it. Both values are required together — `threadId` alone is
 * only unique within one chat, never globally, so looking it up without pinning the chat as well
 * could silently cross-match two different projects' discussion groups that happen to share a
 * thread number. */
export async function resolveThread(pool: Pool, discussionChatId: string, threadId: string): Promise<ThreadMatch | null> {
  if (!discussionChatId || !threadId) return null
  const { rows } = await pool.query<{ project_id: number; id: string }>(
    `SELECT project_id, id FROM social_publications
     WHERE telegram_discussion_chat_id = $1 AND telegram_discussion_thread_id = $2
     LIMIT 1`,
    [discussionChatId, threadId],
  )
  const match = rows[0]
  return match ? { projectId: match.project_id, publicationId: match.id } : null
}

export type InsertCommentResult = { inserted: true; commentId: string } | { inserted: false }

/** Inserts the comment keyed by (project_id, platform, external_comment_id) — the dedup
 * requirement: a webhook redelivery of the same Telegram update, or this app's own retry after a
 * transient failure, can never create a second row. `ON CONFLICT ... DO NOTHING` is atomic under
 * concurrent calls by construction (the unique index itself serializes it), so no advisory lock
 * is needed here, unlike the Social Publisher's own claim mechanism (which guards an external
 * side-effecting call, not a plain insert). */
export async function insertCommentIfNew(
  pool: Pool,
  projectId: number,
  publicationId: string,
  event: TelegramCommentEvent,
): Promise<InsertCommentResult> {
  const id = randomUUID()
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO social_comments
       (id, project_id, social_publication_id, platform, external_comment_id, author_name, author_username, body, external_posted_at)
     VALUES ($1, $2, $3, 'telegram', $4, $5, $6, $7, $8)
     ON CONFLICT (project_id, platform, external_comment_id) DO NOTHING
     RETURNING id`,
    [id, projectId, publicationId, event.externalCommentId, event.authorName, event.authorUsername, event.body, event.postedAt.toISOString()],
  )
  return rows[0] ? { inserted: true, commentId: rows[0].id } : { inserted: false }
}

/** Marks a comment as having had its admin notification actually SENT (not just attempted) —
 * separate from the insert itself so a notification failure (see lib/social-comment-notify.ts,
 * which never throws) never risks the comment row itself. This is the durable signal
 * `listUnnotifiedComments` below retries against: a comment is only ever marked notified once
 * `notifyNewComment` reports success, never merely because it was called. */
export async function markCommentNotified(pool: Pool, commentId: string): Promise<void> {
  await pool.query(`UPDATE social_comments SET notified_at = now() WHERE id = $1 AND notified_at IS NULL`, [commentId])
}

export type UnnotifiedComment = {
  id: string
  projectId: number
  projectName: string
  projectSlug: string
  authorName: string
  authorUsername: string
  body: string
  externalPostedAt: string | null
  createdAt: string
  publicationExternalUrl: string | null
}

/**
 * Comments whose notification never durably succeeded — a Telegram API error, a missing
 * CRM_NOTIFY_TELEGRAM_CHAT_ID at the time, or the process dying between insert and notify would
 * otherwise lose the notification silently forever (the comment itself is always safe; only the
 * *notification* was ever at risk). `olderThanMs` guards against racing the comment that was
 * JUST inserted in the SAME request (its own notify attempt hasn't run yet) — the webhook route's
 * retry sweep only looks at comments old enough that their original attempt has clearly already
 * happened (or never will, e.g. the config was missing at the time).
 *
 * This is the "minimal fix, no separate queue/service" requested: the retry sweep is a plain,
 * bounded SELECT the webhook route itself runs once per incoming update (see that route for why
 * piggybacking on existing traffic — rather than a new timer — is enough for this), not a new
 * scheduled job. Known limitation, stated plainly: a channel with zero further activity never
 * triggers another retry; a stuck notification then waits for the next real comment. Acceptable
 * for this MVP's volume — revisit with a real low-frequency timer (the same systemd-timer pattern
 * lib/social-meta-token-refresh-sweep.ts already uses) if that ever matters in practice.
 */
export async function listUnnotifiedComments(pool: Pool, olderThanMs: number, limit = 5): Promise<UnnotifiedComment[]> {
  const { rows } = await pool.query<{
    id: string
    project_id: number
    project_name: string
    project_slug: string
    author_name: string
    author_username: string
    body: string
    external_posted_at: string | null
    created_at: string
    publication_external_url: string | null
  }>(
    `SELECT c.id, c.project_id, p.name AS project_name, p.slug AS project_slug,
            c.author_name, c.author_username, c.body, c.external_posted_at, c.created_at,
            sp.external_url AS publication_external_url
     FROM social_comments c
     JOIN projects p ON p.id = c.project_id
     LEFT JOIN social_publications sp ON sp.id = c.social_publication_id
     WHERE c.notified_at IS NULL AND c.created_at < now() - ($1 || ' milliseconds')::interval
     ORDER BY c.created_at ASC
     LIMIT $2`,
    [olderThanMs, limit],
  )
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    projectSlug: r.project_slug,
    authorName: r.author_name,
    authorUsername: r.author_username,
    body: r.body,
    externalPostedAt: r.external_posted_at,
    createdAt: r.created_at,
    publicationExternalUrl: r.publication_external_url,
  }))
}

export type CommentListRow = {
  id: string
  author_name: string
  author_username: string
  body: string
  external_posted_at: string | null
  created_at: string
  social_publication_id: string | null
  publication_external_url: string | null
  publication_platform: string | null
}

/** Project-scoped read for the Comments screen — newest first. No "all projects" mode, same
 * deliberate simplicity as the Ads module (see OLNOO_PROJECT_MAP.md's "Ads" section): this is a
 * read-only list, not worth a cross-project join for an MVP with one real channel so far. */
export async function listCommentsForProject(pool: Pool, projectId: number, limit = 200): Promise<CommentListRow[]> {
  const { rows } = await pool.query<CommentListRow>(
    `SELECT c.id, c.author_name, c.author_username, c.body, c.external_posted_at, c.created_at,
            c.social_publication_id, sp.external_url AS publication_external_url, sp.platform AS publication_platform
     FROM social_comments c
     LEFT JOIN social_publications sp ON sp.id = c.social_publication_id
     WHERE c.project_id = $1
     ORDER BY coalesce(c.external_posted_at, c.created_at) DESC
     LIMIT $2`,
    [projectId, limit],
  )
  return rows
}
