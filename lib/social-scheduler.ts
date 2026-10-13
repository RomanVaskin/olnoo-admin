import type { Pool } from 'pg'
import { publishSelectedChannels, type ChannelPublishOutcome } from '@/lib/social-publish-selected'
import { isPublishDue } from '@/lib/social-scheduler-due'
import { withSchedulerLock } from '@/lib/social-scheduler-lock'

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

/**
 * Finds every social_posts row that is status='ready', has at least one selected channel, has a
 * publish_date that has arrived, and still has at least one non-'published' social_publications
 * row — then runs publishSelectedChannels on each, one at a time (sequential, not parallel, to
 * keep load on the one production server and its DB pool predictable during a catch-up sweep after
 * downtime). A post with no publish_date set at all is never picked up here — that's unchanged,
 * intentional manual-publish behavior for posts that were never given a schedule.
 *
 * `retryFailed: false` — this is the one thing that makes a scheduler sweep different from a
 * human clicking "Publish selected channels": a publication already marked 'failed' from a
 * previous attempt (a durable, known failure — bad credentials, missing content, a platform
 * rejecting the content outright) is never automatically retried again here. Without it, every
 * sweep (once a minute) would re-attempt the exact same doomed-to-fail call forever, with no way
 * to stop short of a human intervening. A human can still retry a failed channel explicitly
 * (the manual bulk-publish route/button and the individual "Publish to X" buttons both keep
 * publishSelectedChannels's/each publisher's own default, which does retry).
 *
 * One post's unexpected failure (a thrown exception, not just a failed channel — those are already
 * handled inside publishSelectedChannels) never stops the sweep over the remaining due posts.
 */
export async function runSocialScheduler(pool: Pool, now: Date = new Date()): Promise<SchedulerRunResult> {
  const outcome = await withSchedulerLock(pool, async () => {
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
        const result = await publishSelectedChannels(pool, post.id, post.slug, { retryFailed: false })
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

    return processed
  })

  if (outcome.skipped) {
    return { skipped: true, reason: 'another scheduler run is already in progress' }
  }
  return { skipped: false, processed: outcome.result }
}
