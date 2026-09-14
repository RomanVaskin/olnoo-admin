import type { Pool } from 'pg'
import { publishSelectedChannels, type ChannelPublishOutcome } from '@/lib/social-publish-selected'
import { isPublishDue } from '@/lib/social-scheduler-due'

// The scheduler sweep itself — no new publish logic, no queue, no worker process. It only finds
// which posts are due and hands each one to the exact same publishSelectedChannels fan-out the
// "Publish selected channels" button already calls (which in turn calls the exact same
// Telegram/VK/Instagram/Threads publishers the individual buttons call). Runs synchronously,
// on-demand, triggered by POST /api/social-scheduler/run (see that route for the systemd-timer
// trigger and its token protection).

export type SchedulerPostResult = {
  postId: string
  projectSlug: string
  outcomes: ChannelPublishOutcome[]
  error?: string
}

export type SchedulerRunResult =
  | { skipped: true; reason: string }
  | { skipped: false; processed: SchedulerPostResult[] }

// A single, fixed Postgres advisory lock key for the whole scheduler sweep (not per-post, not
// per-project — only one sweep needs to run at a time on this one server). pg_try_advisory_lock
// is the simplest overlap guard the current Postgres already offers: no new table, no queue, no
// row to clean up if the process crashes (the lock is tied to the DB session/connection and is
// released automatically if that connection drops). If two scheduler runs are ever triggered close
// together (e.g. a slow run still in flight when the next per-minute timer fires), the second one
// finds the lock held, does nothing, and returns immediately — it does not wait or queue up.
// Arbitrary but must stay stable across deploys/restarts (advisory lock keys are just int8 values,
// not tied to any schema).
const SCHEDULER_LOCK_KEY = 727142001

/**
 * Finds every social_posts row that is status='ready', has at least one selected channel, has a
 * publish_date that has arrived, and still has at least one non-'published' social_publications
 * row — then runs publishSelectedChannels on each, one at a time (sequential, not parallel, to
 * keep load on the one production server and its DB pool predictable during a catch-up sweep after
 * downtime). A post with no publish_date set at all is never picked up here — that's unchanged,
 * intentional manual-publish behavior for posts that were never given a schedule.
 *
 * One post's unexpected failure (a thrown exception, not just a failed channel — those are already
 * handled inside publishSelectedChannels) never stops the sweep over the remaining due posts.
 */
export async function runSocialScheduler(pool: Pool, now: Date = new Date()): Promise<SchedulerRunResult> {
  const { rows: lockRows } = await pool.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
    SCHEDULER_LOCK_KEY,
  ])
  if (!lockRows[0]?.locked) {
    return { skipped: true, reason: 'another scheduler run is already in progress' }
  }

  try {
    const { rows: candidates } = await pool.query<{ id: string; slug: string; publish_date: string }>(
      `SELECT sp.id, pr.slug, sp.publish_date
       FROM social_posts sp
       JOIN projects pr ON pr.id = sp.project_id
       WHERE sp.status = 'ready'
         AND sp.channels <> ''
         AND sp.publish_date <> ''
         AND EXISTS (
           SELECT 1 FROM social_publications pub
           WHERE pub.social_post_id = sp.id AND pub.status <> 'published'
         )`,
    )

    const due = candidates.filter((c) => isPublishDue(c.publish_date, now))

    const processed: SchedulerPostResult[] = []
    for (const post of due) {
      try {
        const result = await publishSelectedChannels(pool, post.id, post.slug)
        if ('error' in result) {
          processed.push({ postId: post.id, projectSlug: post.slug, outcomes: [], error: result.error })
        } else {
          processed.push({ postId: post.id, projectSlug: post.slug, outcomes: result.results })
        }
      } catch (err) {
        processed.push({
          postId: post.id,
          projectSlug: post.slug,
          outcomes: [],
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { skipped: false, processed }
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY])
  }
}
