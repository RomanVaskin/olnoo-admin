import type { Pool } from 'pg'
import { callAiRouter, AiRouterError } from './ai-router.ts'
import {
  SOCIAL_AGENT_PLAN_SYSTEM_PROMPT,
  buildSocialAgentPlanPrompt,
  parseSocialAgentPlan,
  SocialAgentPlanError,
  type SocialAgentPlanItem,
} from './social-agent-plan.ts'

// OLNOO Social AI Agent MVP: turns one free-text task ("Подготовь три поста на неделю о
// полировке автомобилей для DriveSet") into several REAL draft rows in the existing Social Posts
// module — no new content model, no new AI provider, no new service/queue/timer, no new DB beyond
// the one small idempotency table this needs (db/migrations/0027_social_agent_runs.sql).
//
// `pool` is injected (same convention as lib/social-comments.ts) — this file has zero `@/`
// imports, so it runs directly under `node --test`. The one thing it does NOT import directly is
// the Social Posts/AI functions it's required to reuse (`createSocialPost`, `generateChannelVariants`,
// `deleteSocialPost`): those live in lib/social.ts/lib/social-ai.ts, which both import `@/lib/db`/
// `@/lib/crm` and so cannot be loaded under this project's plain `node --test` runner at all
// (confirmed: neither file has ever had a test of its own, for exactly this reason — a pre-existing
// gap, not something introduced here). Reusing them without duplicating their logic, while staying
// testable, means taking the "adapt + create" and "delete" steps as an INJECTED dependency
// (`SocialAgentDeps`) — same shape as lib/telegram-comments-handler.ts's own `TelegramCommentsDeps`
// for exactly the same reason. The real wiring (app/api/social/agent-task/route.ts) supplies the
// REAL functions; this file's own tests supply fake ones, so the orchestration/idempotency logic
// below (the part that is actually new) is fully covered even though the underlying Social
// Posts/AI functions themselves cannot be exercised by `node --test` — separately confirmed via
// `npx next build` and manual verification instead (see OLNOO_PROJECT_MAP.md's "OLNOO Social AI
// Agent MVP").

export type CreatedAgentPost = { id: string; topic: string; channels: string[] }

export type SocialAgentDeps = {
  /** Adapts one planned item's text per selected channel (the EXISTING `generateChannelVariants`,
   * lib/social-ai.ts) and creates the real draft row (the EXISTING `createSocialPost`,
   * lib/social.ts) — combined into one call so this file never has to know either function's own
   * shape. Must throw on failure (an AI Router error or a post-creation error) — never return a
   * partial/fake success; `runSocialAgentTask` relies on a thrown error here to trigger rollback. */
  createAdaptedDraftPost: (item: SocialAgentPlanItem) => Promise<CreatedAgentPost>
  /** Deletes an already-created draft (the EXISTING `deleteSocialPost`, lib/social.ts) — used ONLY
   * to roll back a run that fails partway through creating its posts, so a failure never leaves a
   * partial set behind (requirement: "ошибки AI Router не приводят к частично созданным наборам
   * постов"). This is a BEST-EFFORT cleanup, not an atomic one: a failure here is logged, never
   * thrown further, but `runSocialAgentTask` below does NOT then treat the run as a normal,
   * safely-retryable `'failed'` run — see its own comment for why (an unconfirmed cleanup must
   * never be retried automatically, or the retry's fresh batch plus the orphaned leftover(s) from
   * this one become an undetected duplicate). */
  deletePost: (id: string) => Promise<void>
}

export type SocialAgentRunResult =
  | { error: string; status: number }
  | { runId: string; replayed: false; posts: CreatedAgentPost[] }
  | { runId: string; replayed: true; postIds: string[] }

type ClaimResult =
  | { claimed: true }
  | { claimed: false; status: 'completed'; postIds: string[] }
  | { claimed: false; status: 'running' }
  | { claimed: false; status: 'cleanup_failed' }

/**
 * Atomically claims one agent run, keyed by the client-supplied `runId` (a random id minted once
 * per logical "run" — the SAME value is resent when retrying the SAME attempt, e.g. a double click
 * or a network retry; a genuinely new task gets a fresh id). Exactly the same claim shape
 * db/migrations/0026_social_comment_replies.sql introduced for Telegram reply retries, applied
 * here to a different table:
 *
 *   INSERT ... VALUES (..., 'running', ...)
 *   ON CONFLICT (id, project_id) DO UPDATE SET status = 'running', ... WHERE social_agent_runs.status = 'failed'
 *   RETURNING id
 *
 * A fresh (id, project) pair is claimed by the INSERT itself. A pair whose row is already
 * `'completed'` is NEVER reclaimed — the caller replays the SAME result (`postIds`) instead, so
 * repeating a confirmation never creates a second batch. A pair whose row is `'running'` is
 * refused (a genuinely concurrent duplicate). A pair whose row is `'cleanup_failed'` (see
 * `runSocialAgentTask` below) is ALSO refused, permanently, until a human resets it by hand — it
 * is deliberately excluded from the `WHERE … = 'failed'` retry path. Only a CONFIRMED `'failed'`
 * run — one whose rollback is known to have fully succeeded, or that never created a post to begin
 * with — can be retried with the same id, same row, never a second one. Postgres's row lock on the
 * `ON CONFLICT` path serializes concurrent claims for the SAME (id, project_id) the same way
 * `claimPublicationForSending` (lib/social-publication-claim.ts) and `sendCommentReply`
 * (lib/social-comment-reply.ts) already rely on, one level up: whichever request's turn comes
 * first wins; the other sees its own insert silently discarded and is refused.
 *
 * The primary key itself IS project-namespaced — `PRIMARY KEY (id, project_id)`, not `id` alone.
 * `runId` is a client-minted idempotency key scoped to the project the client is working in, never
 * meant to be globally unique: an `id PRIMARY KEY` would let the SAME id collide across two
 * different projects at the `ON CONFLICT` level (Postgres resolves that conflict on `id` before any
 * WHERE clause can check project ownership), so one project's completed run could silently block
 * a different project's genuinely-fresh run that happens to reuse the same id. Composite-keying
 * makes every claim, replay, and retry fully project-scoped by construction.
 */
async function claimAgentRun(pool: Pool, runId: string, projectId: number, task: string): Promise<ClaimResult> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO social_agent_runs (id, project_id, task, status)
     VALUES ($1, $2, $3, 'running')
     ON CONFLICT (id, project_id) DO UPDATE
       SET status = 'running', task = excluded.task, error = '', updated_at = now()
     WHERE social_agent_runs.status = 'failed'
     RETURNING id`,
    [runId, projectId, task],
  )
  if (rows[0]) return { claimed: true }

  const { rows: existingRows } = await pool.query<{ status: string; post_ids: string }>(
    'SELECT status, post_ids FROM social_agent_runs WHERE id = $1 AND project_id = $2',
    [runId, projectId],
  )
  const existing = existingRows[0]
  if (existing?.status === 'completed') {
    return { claimed: false, status: 'completed', postIds: existing.post_ids ? existing.post_ids.split(',') : [] }
  }
  if (existing?.status === 'cleanup_failed') {
    return { claimed: false, status: 'cleanup_failed' }
  }
  // 'running' (a genuinely concurrent duplicate, or a run stuck mid-flight by a process crash —
  // see runSocialAgentTask's own comment on that MVP limitation) falls here, and so does the
  // practically-unreachable cross-project id collision described above — all refused identically.
  return { claimed: false, status: 'running' }
}

async function markAgentRunCompleted(pool: Pool, runId: string, projectId: number, postIds: string[]): Promise<void> {
  await pool.query(
    `UPDATE social_agent_runs SET status = 'completed', post_ids = $1, error = '', updated_at = now() WHERE id = $2 AND project_id = $3`,
    [postIds.join(','), runId, projectId],
  )
}

/** Marks a run `'failed'` — meaning SAFE to retry with the same id: either it never created a
 * single post, or every post it did create was confirmed deleted by `deps.deletePost`. Never call
 * this when a rollback attempt itself failed or its outcome is unknown — use
 * `markAgentRunCleanupFailed` instead (see `runSocialAgentTask`). */
async function markAgentRunFailed(pool: Pool, runId: string, projectId: number, error: string): Promise<void> {
  await pool.query(`UPDATE social_agent_runs SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND project_id = $3`, [
    error,
    runId,
    projectId,
  ])
}

/** Marks a run `'cleanup_failed'` — a terminal, non-retryable state used when rolling back a
 * partially-created batch itself failed (or its success could not be confirmed) for at least one
 * post. Deliberately a different status than `'failed'`: `claimAgentRun`'s retry path only ever
 * matches `WHERE status = 'failed'`, so a `'cleanup_failed'` row can never be auto-retried and
 * silently risk creating a second batch alongside posts that may still exist from this one.
 * `postIds` records the post ids whose deletion could not be confirmed, so a human reviewing this
 * row (directly in Postgres — there is no admin UI for this MVP) knows exactly what to check in
 * `social_posts` before deciding whether to delete them by hand and reset the row to `'failed'`. */
async function markAgentRunCleanupFailed(pool: Pool, runId: string, projectId: number, error: string, unconfirmedPostIds: string[]): Promise<void> {
  await pool.query(
    `UPDATE social_agent_runs SET status = 'cleanup_failed', post_ids = $1, error = $2, updated_at = now() WHERE id = $3 AND project_id = $4`,
    [unconfirmedPostIds.join(','), error, runId, projectId],
  )
}

/**
 * Runs one Social AI Agent task end to end: resolve the project's connected channels → plan via
 * the AI Router → (per planned item) adapt + create a real draft via `deps` → mark the run
 * complete. See the file-level comment for why `deps` exists instead of a direct import, and
 * `claimAgentRun` above for the full idempotency argument.
 *
 * No partial sets on failure (requirement): the AI Router call happens entirely before any post is
 * created (a planning failure writes zero posts). If `deps.createAdaptedDraftPost` itself throws
 * partway through the loop — an AI Router error during per-channel adaptation, or a post-creation
 * error — every post THIS run already created is rolled back via `deps.deletePost` before the run
 * is marked done.
 *
 * That rollback is BEST-EFFORT, not atomic — `deps.deletePost` is a real network/DB call that can
 * itself fail. This function never claims otherwise: it only marks the run as the safely-retryable
 * `'failed'` when every rollback it attempted is CONFIRMED to have succeeded (or there was nothing
 * to roll back at all). If even one `deletePost` call throws, the outcome of that one post is
 * unknown — it may or may not actually be gone — so the run is marked `'cleanup_failed'` instead: a
 * terminal status `claimAgentRun` never reclaims, keeping the run fully non-retryable until a human
 * reviews the surviving `social_posts` row(s) (recorded in `post_ids`) and resets it by hand. This
 * is the fix for a real risk the first version of this file had: marking every failure `'failed'`
 * regardless of whether cleanup actually succeeded meant an unconfirmed leftover draft plus an
 * auto-retried fresh batch could silently become a duplicate.
 *
 * MVP limitation, deliberately not fixed here (would need a lease/heartbeat mechanism — out of
 * scope for "no new services/queues"): if the Node process crashes between creating a post and
 * this function reaching `markAgentRunCompleted`/`markAgentRunFailed`/`markAgentRunCleanupFailed`,
 * the row is left `'running'` forever. `claimAgentRun` only ever reclaims `'failed'`, so that run
 * can never be auto-retried either — safe against duplicates, but stuck: a human must inspect
 * `social_posts` for that project/task and manually `UPDATE social_agent_runs SET status = 'failed'
 * WHERE id = …` (after first deleting any draft that real run did create, if a retry should start
 * clean) before the same `runId` can be used again.
 */
export async function runSocialAgentTask(
  pool: Pool,
  projectId: number,
  runId: string,
  task: string,
  deps: SocialAgentDeps,
): Promise<SocialAgentRunResult> {
  const trimmedTask = task.trim()
  if (!trimmedTask) return { error: 'task is required', status: 400 }
  if (!runId.trim()) return { error: 'runId is required', status: 400 }

  const { rows: channelRows } = await pool.query<{ platform: string }>(
    `SELECT DISTINCT platform FROM social_accounts WHERE project_id = $1 AND active = true`,
    [projectId],
  )
  const availableChannels = channelRows.map((r) => r.platform)
  if (availableChannels.length === 0) {
    return { error: 'no connected channel is active for this project yet — connect one in Social → Accounts first', status: 400 }
  }

  const claim = await claimAgentRun(pool, runId, projectId, trimmedTask)
  if (!claim.claimed) {
    if (claim.status === 'completed') {
      return { runId, replayed: true, postIds: claim.postIds }
    }
    if (claim.status === 'cleanup_failed') {
      return {
        error: 'a previous attempt for this task could not be fully cleaned up and needs manual review before it can be retried',
        status: 409,
      }
    }
    return { error: 'this task is already running — please wait for it to finish before retrying', status: 409 }
  }

  let projectContext = ''
  const { rows: projectRows } = await pool.query<{ name: string; domain: string }>('SELECT name, domain FROM projects WHERE id = $1', [
    projectId,
  ])
  if (projectRows[0]) projectContext = `${projectRows[0].name} (${projectRows[0].domain})`

  let planItems: SocialAgentPlanItem[]
  try {
    const content = await callAiRouter(
      [
        { role: 'system', content: SOCIAL_AGENT_PLAN_SYSTEM_PROMPT },
        { role: 'user', content: buildSocialAgentPlanPrompt({ task: trimmedTask, projectContext, availableChannels }) },
      ],
      { temperature: 0.4, task: 'social-agent-plan' },
    )
    planItems = parseSocialAgentPlan(content, availableChannels)
  } catch (err) {
    const message = err instanceof AiRouterError || err instanceof SocialAgentPlanError ? err.message : err instanceof Error ? err.message : String(err)
    await markAgentRunFailed(pool, runId, projectId, message)
    return { error: message, status: 422 }
  }

  const created: CreatedAgentPost[] = []
  try {
    for (const item of planItems) {
      const post = await deps.createAdaptedDraftPost(item)
      created.push(post)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Best-effort rollback (see the file-level comment on `deletePost` and this function's own
    // comment above) — track exactly which deletes we could NOT confirm, rather than assuming the
    // whole batch is cleanly gone just because every deletePost call was attempted.
    const unconfirmed: string[] = []
    for (const post of created) {
      try {
        await deps.deletePost(post.id)
      } catch (cleanupErr) {
        unconfirmed.push(post.id)
        console.error('[social-agent] failed to roll back a partially-created draft — leaving it for manual review:', post.id, cleanupErr)
      }
    }
    if (unconfirmed.length > 0) {
      await markAgentRunCleanupFailed(pool, runId, projectId, message, unconfirmed)
      return {
        error: 'the request failed and some draft posts could not be automatically removed — manual review is required before this task can be retried',
        status: 500,
      }
    }
    await markAgentRunFailed(pool, runId, projectId, message)
    return { error: message, status: 422 }
  }

  await markAgentRunCompleted(
    pool,
    runId,
    projectId,
    created.map((p) => p.id),
  )
  return { runId, replayed: false, posts: created }
}
