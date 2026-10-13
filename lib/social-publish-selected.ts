import type { Pool } from 'pg'
import { resolveProjectId } from '@/lib/crm'
import { getSocialPost, isSocialChannel, type SocialChannel } from '@/lib/social'
import { publishSocialPublicationToTelegram } from '@/lib/social-telegram'
import { publishSocialPublicationToVk } from '@/lib/social-vk'
import { publishSocialPublicationToInstagram } from '@/lib/social-instagram'
import { publishSocialPublicationToThreads } from '@/lib/social-threads'
import { outcomeFromPublisherResult, type ChannelOutcome, type PublisherCallResult } from '@/lib/social-publish-selected-outcome'
import { shouldAttemptPublicationTarget } from '@/lib/social-publish-selected-targets'

// Fan-out only — no new publish logic of its own. Every channel below already has its own
// automated publisher (Telegram/VK/Instagram/Threads); this just calls the same function the
// individual "Publish to X" button already calls, once per currently-selected, not-yet-published
// channel, and collects the outcomes. No new table, queue, cron, or service.

export type ChannelPublishOutcome = {
  id: string
  platform: SocialChannel
  outcome: ChannelOutcome
  externalUrl: string
  error: string
}

export type PublishSelectedResult = { error: string; status: number } | { results: ChannelPublishOutcome[] }

type Publisher = (pool: Pool, id: string, projectSlug: string | null) => Promise<PublisherCallResult>

const PUBLISHERS: Record<SocialChannel, Publisher> = {
  telegram: publishSocialPublicationToTelegram,
  vk: publishSocialPublicationToVk,
  instagram: publishSocialPublicationToInstagram,
  threads: publishSocialPublicationToThreads,
}

/**
 * Publishes a post to every one of its currently-selected channels that isn't already published,
 * one existing publisher call per channel, run independently of each other — a failure (or a
 * thrown exception) on one channel never stops or is reported against another. Channels not
 * currently selected on the post (even if a publication row still exists for them) are skipped,
 * same as the per-channel buttons already only operate on a specific publication.
 *
 * Each existing publisher already refuses to re-send an already-published row (409) — as a second
 * layer on top of the already-published pre-filter here, a 409 encountered mid-run (e.g. published
 * by a concurrent request between the read above and this call) is reported as
 * 'already_published', not 'failed'. Every other publisher error (no account, no content, missing
 * Instagram image, a real platform API error, …) is reported as 'failed' with that channel's own
 * message, exactly as it already reads on the individual publication row — this function changes
 * none of that per-platform behavior.
 *
 * `retryFailed` (default `true`, so every existing caller's behavior is unchanged unless it opts
 * out) decides whether a target already marked 'failed' from a previous attempt is attempted again
 * by THIS call. The scheduler (lib/social-scheduler.ts) passes `false` so a durable, known failure
 * is never automatically retried forever; the manual "Publish selected channels" button keeps the
 * default so a human can still deliberately retry one.
 */
export async function publishSelectedChannels(
  pool: Pool,
  postId: string,
  projectSlug: string | null,
  options: { retryFailed?: boolean } = {},
): Promise<PublishSelectedResult> {
  const retryFailed = options.retryFailed ?? true
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const post = await getSocialPost(postId, projectSlug)
  if (!post) return { error: 'not found', status: 404 }

  const rawChannels = typeof post.channels === 'string' ? post.channels : ''
  const channels = rawChannels.split(',').filter(isSocialChannel)
  if (channels.length === 0) return { error: 'this post has no channels selected', status: 400 }

  const { rows: pubRows } = await pool.query<{ id: string; platform: string; status: string; external_url: string }>(
    'SELECT id, platform, status, external_url FROM social_publications WHERE social_post_id = $1 AND project_id = $2',
    [postId, projectId],
  )

  const targets = pubRows.filter(
    (p) =>
      channels.includes(p.platform as SocialChannel) &&
      isSocialChannel(p.platform) &&
      shouldAttemptPublicationTarget(p.status, retryFailed),
  )

  const results = await Promise.all(
    targets.map(async (pub): Promise<ChannelPublishOutcome> => {
      const platform = pub.platform as SocialChannel
      if (pub.status === 'published') {
        return { id: pub.id, platform, outcome: 'already_published', externalUrl: pub.external_url || '', error: '' }
      }
      try {
        const result = await PUBLISHERS[platform](pool, pub.id, projectSlug)
        return { id: pub.id, platform, ...outcomeFromPublisherResult(result, pub.external_url || '') }
      } catch (err) {
        return { id: pub.id, platform, outcome: 'failed', externalUrl: '', error: err instanceof Error ? err.message : String(err) }
      }
    }),
  )

  return { results }
}
