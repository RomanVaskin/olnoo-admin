import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { telegramIdentifiersMatch } from './social-telegram-verify.ts'
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
//
// --- Why every check-then-act sequence below runs inside a Postgres advisory-lock transaction ---
//
// migrations 0024/0025 fixed a lost-event problem (an auto-forward, or a comment, arriving before
// its counterpart commits) by recording the not-yet-resolvable event instead of discarding it. A
// review of that fix found a RESIDUAL race: two independent "check X, if absent write Y" sequences
// (linkAutoForward's, and resolvePendingAutoForwardForPublication's) running as separate,
// unsynchronized statements can still interleave as: (1) linkAutoForward checks for the publication
// — absent; (2) the publish call commits external_post_id; (3)
// resolvePendingAutoForwardForPublication checks the pending table — ALSO absent, since step 1
// hasn't written it yet; (4) linkAutoForward (only now) writes the pending row — too late, nothing
// will ever look for it again. Each individual statement was fine; the GAP between two statements
// in the SAME function, during which the OTHER function's own check could run, was the bug.
//
// Fix: each "check X, if absent write Y" sequence below runs inside one transaction holding a
// `pg_advisory_xact_lock` (same mechanism as lib/telegram-business-lead.ts's
// `findOrCreateTelegramLead` and lib/social-accounts-telegram-connection.ts's connect guard) keyed
// so that the TWO SIDES of a given race share the same key. Two keys, matching the two independent
// "is this new?" questions this feature has to answer:
//   - `autoForwardLockKey(projectId, externalPostId)` — serializes linkAutoForward's reconciliation
//     against resolvePendingAutoForwardForPublication's, for the SAME post. Whichever side's
//     transaction starts first now runs its ENTIRE check-then-act atomically before the other side's
//     check can even begin — there is no longer a gap in which the second side's check can observe a
//     stale "not there yet" state for something the first side was in the middle of writing.
//   - `threadLockKey(discussionChatId, threadId)` — serializes the "stamp the thread + replay any
//     comments that arrived too early" step (run by whichever of the two functions above wins the
//     race above) against resolveThread's own "is this thread linked yet, if not remember this
//     comment" check — the exact same category of gap, one level down, for a comment instead of an
//     auto-forward. Acquired as a SECOND lock, nested inside the first where both are needed
//     (independent keys, same transaction — Postgres advisory locks are reentrant-safe across
//     distinct keys and both release together at COMMIT/ROLLBACK).
// No new service, queue, or timer — only Postgres, same constraint as 0024/0025 themselves.

export type ThreadMatch = { projectId: number; publicationId: string }

function autoForwardLockKey(projectId: number, externalPostId: string): string {
  return `tg-autofwd:${projectId}:${externalPostId}`
}

function threadLockKey(discussionChatId: string, threadId: string): string {
  return `tg-thread:${discussionChatId}:${threadId}`
}

/** Stamps the (chat, thread) pair onto a matched publication row — the one UPDATE both
 * `linkAutoForward` and `resolvePendingAutoForwardForPublication` below need, extracted so the
 * idempotency guard (never silently overwrite a DIFFERENT already-recorded mapping) lives in
 * exactly one place. Always called with the `client` already holding `threadLockKey` for this
 * exact (chat, thread) pair — see the file-level comment above. */
async function stampDiscussionThread(
  client: PoolClient,
  publicationId: string,
  projectId: number,
  discussionChatId: string,
  threadId: string,
): Promise<void> {
  await client.query(
    `UPDATE social_publications
     SET telegram_discussion_chat_id = $1, telegram_discussion_thread_id = $2, updated_at = now()
     WHERE id = $3 AND project_id = $4
       AND (telegram_discussion_thread_id = '' OR (telegram_discussion_chat_id = $1 AND telegram_discussion_thread_id = $2))`,
    [discussionChatId, threadId, publicationId, projectId],
  )
}

/** Finds the one connected, active Telegram account whose `username` refers to the same channel
 * as `forwardFromChatUsername`/`forwardFromChatId` — via `telegramIdentifiersMatch`, which
 * normalizes BOTH sides before comparing (see that function's own comment for why a raw/un-
 * normalized comparison of the stored column, as an earlier version of this file did, could fail
 * to match a validly-connected channel depending on which of the three equivalent text forms
 * happened to be stored). The account list is small by construction — one row per project's
 * connected Telegram channel — so matching in application code rather than a more complex SQL
 * normalization expression is the simpler, equally correct choice here. */
async function findAccountForChannel(
  pool: Pool,
  forwardFromChatUsername: string,
  forwardFromChatId: string,
): Promise<{ projectId: number; username: string } | null> {
  if (!forwardFromChatUsername && !forwardFromChatId) return null
  const { rows } = await pool.query<{ project_id: number; username: string }>(
    `SELECT project_id, username FROM social_accounts WHERE platform = 'telegram' AND active = true`,
  )
  const match = rows.find(
    (a) =>
      (forwardFromChatUsername && telegramIdentifiersMatch(a.username, forwardFromChatUsername)) ||
      (forwardFromChatId && telegramIdentifiersMatch(a.username, forwardFromChatId)),
  )
  return match ? { projectId: match.project_id, username: match.username } : null
}

/**
 * An automatic-forward event means a channel post just appeared in its linked discussion group.
 * Resolves the one project whose connected Telegram channel matches `forwardFromChatId`/
 * `forwardFromChatUsername` AND whose `social_publications` row has `external_post_id =
 * forwardFromMessageId` within THAT project — never across projects, since the lookup below is
 * scoped by the matched account's own `project_id`. Returns `null` (never guessed) if no
 * connected project's channel matches, or no publication matches within it (e.g. a post made
 * directly in the channel, outside OLNOO Admin's own publish flow, OR — see
 * db/migrations/0024_social_telegram_pending_auto_forwards.sql — a post whose own publish call
 * simply hasn't committed `external_post_id` yet: this is a real race, not a hypothetical one, so
 * that second case is recorded as a pending event rather than silently discarded, and
 * `resolvePendingAutoForwardForPublication` below completes the link once the publish side
 * catches up).
 *
 * Idempotent: if the matched publication already carries this EXACT (chat, thread) pair, the
 * stamp is a harmless no-op (redelivery of the same auto-forward event); if it already carries a
 * DIFFERENT one, the existing mapping is left alone rather than silently overwritten — the match
 * is still reported, since the project/publication identity doesn't depend on which mapping won.
 */
export async function linkAutoForward(pool: Pool, event: TelegramAutoForwardEvent): Promise<ThreadMatch | null> {
  const account = await findAccountForChannel(pool, event.forwardFromChatUsername, event.forwardFromChatId)
  if (!account) {
    // No connected, active Telegram account matches this forward's channel at all — e.g. a post
    // made directly in some other channel entirely. Not part of the race this file fixes (nothing
    // concurrently writes social_accounts from this flow), so no lock is needed for this branch.
    // Diagnostic only: channel/message ids are not personal data; no author/comment content exists
    // on an auto-forward event to begin with.
    console.warn('[social-comments] thread_unknown: no connected Telegram account matches this channel', {
      discussionChatId: event.discussionChatId,
      threadId: event.threadId,
      forwardFromChatId: event.forwardFromChatId,
    })
    await rememberPendingAutoForward(pool, event)
    return null
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serializes this whole check-then-act sequence against resolvePendingAutoForwardForPublication's
    // own, for the SAME (project, message) — see the file-level comment on why this closes the
    // residual race a review found in the original fix.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [autoForwardLockKey(account.projectId, event.forwardFromMessageId)])

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM social_publications WHERE project_id = $1 AND platform = 'telegram' AND external_post_id = $2 LIMIT 1`,
      [account.projectId, event.forwardFromMessageId],
    )
    const publication = rows[0]
    if (!publication) {
      // The channel IS known, but no publication row has this external_post_id yet. In production
      // this is the actual race db/migrations/0024 fixes: the publish call's own sendMessage
      // response (and therefore its external_post_id UPDATE) can simply not have committed yet
      // when Telegram already forwarded the post and called this webhook — recorded as pending
      // rather than lost, and resolvePendingAutoForwardForPublication below completes it once the
      // publish does land. The lock above guarantees that by the time
      // resolvePendingAutoForwardForPublication's own check for this exact (project, message) can
      // run, THIS pending row (written below, before COMMIT) is already durably visible to it.
      console.warn('[social-comments] thread_unknown: channel matched, no publication with this external_post_id yet — stored pending', {
        projectId: account.projectId,
        discussionChatId: event.discussionChatId,
        threadId: event.threadId,
        forwardFromMessageId: event.forwardFromMessageId,
      })
      await rememberPendingAutoForward(client, event)
      await client.query('COMMIT')
      return null
    }

    // Second, independent lock for the thread-level half of this same category of race (a comment
    // arriving in the gap before the stamp below commits) — see the file-level comment.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [threadLockKey(event.discussionChatId, event.threadId)])
    await stampDiscussionThread(client, publication.id, account.projectId, event.discussionChatId, event.threadId)
    await forgetPendingAutoForward(client, event.discussionChatId, event.threadId)
    await replayPendingComments(client, account.projectId, publication.id, event.discussionChatId, event.threadId)
    await client.query('COMMIT')
    return { projectId: account.projectId, publicationId: publication.id }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Persists a not-yet-resolvable auto-forward event so it can be completed later from the publish
 * side (`resolvePendingAutoForwardForPublication`) instead of being lost — see
 * db/migrations/0024_social_telegram_pending_auto_forwards.sql for why this exists and why it's
 * safe with no new queue/timer/service. Accepts either a `Pool` (the "channel unknown" branch,
 * which runs outside any lock/transaction since nothing races it) or a `PoolClient` already
 * holding `autoForwardLockKey` for this (project, message) (the "pending" branch inside
 * `linkAutoForward`'s locked transaction above). A redelivery of the same auto-forward event (same
 * discussion chat + thread) refreshes the one existing row for it rather than accumulating a
 * second pending entry. Opportunistically prunes pending rows older than 7 days on every insert —
 * bounded, inline cleanup, not a new scheduled job — so a post whose matching publish-side commit
 * never arrives doesn't grow this table forever. */
async function rememberPendingAutoForward(pool: Pool | PoolClient, event: TelegramAutoForwardEvent): Promise<void> {
  await pool.query(
    `INSERT INTO social_telegram_pending_auto_forwards
       (id, discussion_chat_id, thread_id, forward_from_chat_id, forward_from_chat_username, forward_from_message_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (discussion_chat_id, thread_id) DO UPDATE SET
       forward_from_chat_id = excluded.forward_from_chat_id,
       forward_from_chat_username = excluded.forward_from_chat_username,
       forward_from_message_id = excluded.forward_from_message_id,
       created_at = now()`,
    [randomUUID(), event.discussionChatId, event.threadId, event.forwardFromChatId, event.forwardFromChatUsername, event.forwardFromMessageId],
  )
  await pool.query(`DELETE FROM social_telegram_pending_auto_forwards WHERE created_at < now() - interval '7 days'`)
}

async function forgetPendingAutoForward(client: PoolClient, discussionChatId: string, threadId: string): Promise<void> {
  await client.query(`DELETE FROM social_telegram_pending_auto_forwards WHERE discussion_chat_id = $1 AND thread_id = $2`, [
    discussionChatId,
    threadId,
  ])
}

/**
 * The publish side's half of the race fix: called right after `social_publications.external_post_id`
 * is actually committed (lib/social-telegram.ts, immediately after its own success UPDATE) — looks
 * for a pending auto-forward event (recorded by `linkAutoForward` above, because the webhook had
 * arrived first) whose `forward_from_message_id` matches `externalPostId` AND whose channel
 * identity matches the account this publication was just sent through. If found, stamps the
 * thread onto this publication and consumes (deletes) the pending row — this is what makes linking
 * succeed regardless of which side wins the race. Returns `null`, never throws, when there is
 * nothing pending to resolve (the normal case: the webhook simply hasn't arrived yet, or never
 * will for a post made outside OLNOO Admin) — the caller treats this as a no-op, not an error.
 *
 * Runs its whole check-then-act sequence inside the SAME `autoForwardLockKey(projectId,
 * externalPostId)` lock `linkAutoForward` uses — see the file-level comment for why this is what
 * actually closes the race (rather than each side merely being individually atomic).
 */
export async function resolvePendingAutoForwardForPublication(
  pool: Pool,
  projectId: number,
  publicationId: string,
  accountUsername: string,
  externalPostId: string,
): Promise<ThreadMatch | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [autoForwardLockKey(projectId, externalPostId)])

    const { rows } = await client.query<{
      discussion_chat_id: string
      thread_id: string
      forward_from_chat_id: string
      forward_from_chat_username: string
    }>(
      `SELECT discussion_chat_id, thread_id, forward_from_chat_id, forward_from_chat_username
       FROM social_telegram_pending_auto_forwards
       WHERE forward_from_message_id = $1`,
      [externalPostId],
    )
    const pending = rows.find(
      (r) =>
        (r.forward_from_chat_username && telegramIdentifiersMatch(accountUsername, r.forward_from_chat_username)) ||
        (r.forward_from_chat_id && telegramIdentifiersMatch(accountUsername, r.forward_from_chat_id)),
    )
    if (!pending) {
      await client.query('COMMIT')
      return null
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [threadLockKey(pending.discussion_chat_id, pending.thread_id)])
    await stampDiscussionThread(client, publicationId, projectId, pending.discussion_chat_id, pending.thread_id)
    await forgetPendingAutoForward(client, pending.discussion_chat_id, pending.thread_id)
    await replayPendingComments(client, projectId, publicationId, pending.discussion_chat_id, pending.thread_id)
    await client.query('COMMIT')
    return { projectId, publicationId }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Resolves a comment's (discussionChatId, threadId) pair to the project/publication a prior
 * `linkAutoForward` call recorded for it. Both values are required together — `threadId` alone is
 * only unique within one chat, never globally, so looking it up without pinning the chat as well
 * could silently cross-match two different projects' discussion groups that happen to share a
 * thread number.
 *
 * `unattributedEvent` is optional and is the actual fix for "a comment arriving before the thread
 * link completes must not be lost": when provided and no match is found YET, the comment itself is
 * recorded (`rememberPendingComment`) instead of being dropped — `replayPendingComments` (called by
 * `linkAutoForward`/`resolvePendingAutoForwardForPublication` right after they stamp this exact
 * thread) inserts it into `social_comments` the moment the thread does link, so the comment is
 * delayed, never lost, even though `handleTelegramCommentsUpdate` still reports
 * `comment_unattributed` for THIS particular webhook call (Telegram is never kept waiting or asked
 * to redeliver for this). Called with no 3rd argument (3 of the test/verification call sites in
 * this repo) for a pure lookup that doesn't need to remember anything.
 *
 * Runs inside the SAME `threadLockKey` lock `linkAutoForward`/`resolvePendingAutoForwardForPublication`
 * take before stamping+replaying — see the file-level comment: without this, the exact same
 * check-then-act gap that originally lost auto-forward events could lose a comment instead (this
 * check and the stamp+replay step racing, each seeing the other's "before" state).
 */
export async function resolveThread(
  pool: Pool,
  discussionChatId: string,
  threadId: string,
  unattributedEvent?: TelegramCommentEvent,
): Promise<ThreadMatch | null> {
  if (!discussionChatId || !threadId) return null

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [threadLockKey(discussionChatId, threadId)])

    const { rows } = await client.query<{ project_id: number; id: string }>(
      `SELECT project_id, id FROM social_publications
       WHERE telegram_discussion_chat_id = $1 AND telegram_discussion_thread_id = $2
       LIMIT 1`,
      [discussionChatId, threadId],
    )
    const match = rows[0]
    if (!match) {
      // comment_unattributed: this thread was never linked by a prior linkAutoForward call — the
      // comment itself (author name/username/body) is never logged here, only the chat/thread ids,
      // which identify a post's discussion thread, not a person.
      console.warn('[social-comments] comment_unattributed: no publication has recorded this thread yet', { discussionChatId, threadId })
      if (unattributedEvent) await rememberPendingComment(client, unattributedEvent)
      await client.query('COMMIT')
      return null
    }
    await client.query('COMMIT')
    return { projectId: match.project_id, publicationId: match.id }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Persists a comment that arrived before its thread was linked, so `replayPendingComments` can
 * insert it into `social_comments` the moment the thread does link — see `resolveThread`'s own
 * comment and db/migrations/0025_social_telegram_pending_comments.sql. Keyed by (discussion chat,
 * thread, external comment id) so a webhook redelivery before the thread links never stores a
 * second copy. Opportunistically prunes rows older than 7 days on every insert — bounded, inline,
 * no new timer — so a comment on a post made entirely outside OLNOO Admin (whose thread will never
 * link) doesn't grow this table forever. */
async function rememberPendingComment(client: PoolClient, event: TelegramCommentEvent): Promise<void> {
  await client.query(
    `INSERT INTO social_telegram_pending_comments
       (id, discussion_chat_id, thread_id, external_comment_id, author_name, author_username, body, external_posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (discussion_chat_id, thread_id, external_comment_id) DO NOTHING`,
    [randomUUID(), event.discussionChatId, event.threadId, event.externalCommentId, event.authorName, event.authorUsername, event.body, event.postedAt.toISOString()],
  )
  await client.query(`DELETE FROM social_telegram_pending_comments WHERE created_at < now() - interval '7 days'`)
}

/** Inserts every comment `rememberPendingComment` stashed for this (chat, thread) pair, now that it
 * has just been linked to `publicationId`/`projectId` — then deletes the pending rows (consumed,
 * never replayed twice). Always called from within the SAME transaction that just stamped this
 * thread, while still holding `threadLockKey` for it (see `linkAutoForward`/
 * `resolvePendingAutoForwardForPublication`), so a comment `resolveThread` is concurrently deciding
 * to remember for this exact thread can never slip through un-replayed: either `resolveThread`'s
 * own lock-guarded check already found this match (now that it is stamped) and never had anything
 * to remember, or it stored the comment before this lock-guarded step could begin, in which case it
 * is found and replayed right here. Each replayed comment is inserted via the same
 * `insertCommentIfNew` dedup path as a live comment, with `notified_at` left NULL — the existing
 * `listUnnotifiedComments`/`retryUnnotifiedComments` sweep (already run at the end of every webhook
 * call) sends its notification on a later call; no new notifier wiring needed here. */
async function replayPendingComments(
  client: PoolClient,
  projectId: number,
  publicationId: string,
  discussionChatId: string,
  threadId: string,
): Promise<void> {
  const { rows } = await client.query<{
    external_comment_id: string
    author_name: string
    author_username: string
    body: string
    external_posted_at: string | null
  }>(
    `SELECT external_comment_id, author_name, author_username, body, external_posted_at
     FROM social_telegram_pending_comments
     WHERE discussion_chat_id = $1 AND thread_id = $2`,
    [discussionChatId, threadId],
  )
  for (const row of rows) {
    const event: TelegramCommentEvent = {
      kind: 'comment',
      discussionChatId,
      threadId,
      externalCommentId: row.external_comment_id,
      authorName: row.author_name,
      authorUsername: row.author_username,
      body: row.body,
      postedAt: row.external_posted_at ? new Date(row.external_posted_at) : new Date(),
    }
    await insertCommentIfNew(client, projectId, publicationId, event)
  }
  await client.query(`DELETE FROM social_telegram_pending_comments WHERE discussion_chat_id = $1 AND thread_id = $2`, [
    discussionChatId,
    threadId,
  ])
}

export type InsertCommentResult = { inserted: true; commentId: string } | { inserted: false }

/** Inserts the comment keyed by (project_id, platform, external_comment_id) — the dedup
 * requirement: a webhook redelivery of the same Telegram update, or this app's own retry after a
 * transient failure, can never create a second row. `ON CONFLICT ... DO NOTHING` is atomic under
 * concurrent calls by construction (the unique index itself serializes it), so no advisory lock
 * is needed here, unlike the Social Publisher's own claim mechanism (which guards an external
 * side-effecting call, not a plain insert). */
export async function insertCommentIfNew(
  pool: Pool | PoolClient,
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
  // AI-suggested-reply feature (lib/social-comment-reply.ts) — at most one reply per comment (see
  // db/migrations/0026_social_comment_replies.sql), so a plain LEFT JOIN is enough; all four are
  // null when nothing has ever been sent yet, letting the UI show "Suggest a reply" instead.
  reply_status: string | null
  reply_body: string | null
  reply_external_message_id: string | null
  reply_error: string | null
}

/** Project-scoped read for the Comments screen — newest first. No "all projects" mode, same
 * deliberate simplicity as the Ads module (see OLNOO_PROJECT_MAP.md's "Ads" section): this is a
 * read-only list, not worth a cross-project join for an MVP with one real channel so far. */
export async function listCommentsForProject(pool: Pool, projectId: number, limit = 200): Promise<CommentListRow[]> {
  const { rows } = await pool.query<CommentListRow>(
    `SELECT c.id, c.author_name, c.author_username, c.body, c.external_posted_at, c.created_at,
            c.social_publication_id, sp.external_url AS publication_external_url, sp.platform AS publication_platform,
            r.status AS reply_status, r.body AS reply_body, r.external_reply_message_id AS reply_external_message_id, r.error AS reply_error
     FROM social_comments c
     LEFT JOIN social_publications sp ON sp.id = c.social_publication_id
     LEFT JOIN social_comment_replies r ON r.social_comment_id = c.id AND r.project_id = c.project_id
     WHERE c.project_id = $1
     ORDER BY coalesce(c.external_posted_at, c.created_at) DESC
     LIMIT $2`,
    [projectId, limit],
  )
  return rows
}
