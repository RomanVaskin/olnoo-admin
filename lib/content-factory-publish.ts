import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { createSocialPost, getSocialPost } from '@/lib/social'
import { publishSocialPublicationToTelegram } from '@/lib/social-telegram'
import { getItem, setItemSocialPostId, setItemStatus, canPublish, type ContentFactoryItem } from '@/lib/content-factory-items'

// Контент-завод — hands a generated item off to the EXISTING Social Posts/Publications module
// to actually reach Telegram. This file creates nothing new on the publishing side: it calls the
// exact same `createSocialPost` (lib/social.ts) every other post in this app goes through — which
// is what creates the `social_publications` draft row via its own `ensurePublicationsForChannels`
// — and the exact same `publishSocialPublicationToTelegram` (lib/social-telegram.ts) the "Publish
// to Telegram" button already calls, inheriting its existing project-scoped account lookup,
// atomic claim-before-send, and failed/unknown-outcome handling unchanged.
//
// Uses the shared `@/lib/db` pool directly (not pool-injected) — the same posture
// lib/social-publications.ts already has, since it glues into lib/social.ts/lib/social-telegram.ts
// which are themselves written against that shared pool, not a testable injected one.

export class ContentFactoryPublishError extends Error {}

/**
 * Publishes one item's already-approved generated text to the project's Telegram channel, via
 * the existing Social module end to end. Project isolation is enforced the same way every other
 * Content Factory route enforces it (the item itself is only ever resolved by `(id, projectId)`
 * from the caller's own project slug) — this can never publish AURELMAR's item into DriveSet's (or
 * any other project's) Telegram channel, because the `social_posts`/`social_publications` rows it
 * creates belong to the exact same `projectId` the item itself belongs to, not to whatever project
 * happens to be selected in the browser.
 *
 * Idempotent against a retried click: once an item has a `social_post_id` (set the first time
 * this function creates one), a repeat call reuses that same post/publication row rather than
 * creating a second one — `publishSocialPublicationToTelegram`'s own atomic claim then refuses a
 * genuinely concurrent second send, and a definitively failed send is simply retried against the
 * same row, never duplicated.
 */
export async function publishContentFactoryItem(projectSlug: string, itemId: string): Promise<{ error: string; status: number } | { item: ContentFactoryItem }> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const item = await getItem(pool, projectId, itemId)
  if (!item) return { error: 'not found', status: 404 }

  if (!item.socialPostId && !canPublish(item.status)) {
    return { error: `Item is not ready to publish (status: ${item.status}). Approve it first.`, status: 409 }
  }
  if (!item.generatedText.trim()) {
    return { error: 'This item has no prepared text yet — generate one first.', status: 400 }
  }

  let socialPostId = item.socialPostId
  if (!socialPostId) {
    const created = await createSocialPost(projectSlug, {
      topic: item.generatedTitle || 'Content Factory',
      body: item.generatedText,
      channels: ['telegram'],
      status: 'ready',
    })
    if ('error' in created) return { error: created.error, status: created.status }
    socialPostId = created.row.id as string
    await setItemSocialPostId(pool, projectId, item.id, socialPostId)
  }

  const post = await getSocialPost(socialPostId, projectSlug)
  if (!post) return { error: 'the linked post could not be found', status: 404 }

  const { rows: pubRows } = await pool.query<{ id: string }>(
    `SELECT id FROM social_publications WHERE social_post_id = $1 AND project_id = $2 AND platform = 'telegram'`,
    [socialPostId, projectId],
  )
  const publicationId = pubRows[0]?.id
  if (!publicationId) return { error: 'no Telegram publication row exists for this post', status: 500 }

  await setItemStatus(pool, projectId, item.id, { status: 'scheduled' })

  const result = await publishSocialPublicationToTelegram(pool, publicationId, projectSlug)
  if ('error' in result) {
    // Left as 'failed' rather than reverting to 'ready' so the queue makes the problem visible;
    // `socialPostId` is already set at this point, so a retry click bypasses the status gate
    // above entirely and simply calls `publishSocialPublicationToTelegram` again on the same
    // publication row — which itself refuses a genuinely concurrent duplicate send and otherwise
    // just retries the last (failed, or unconfirmed/"unknown") outcome, never creating a second
    // post or publication row.
    await setItemStatus(pool, projectId, item.id, { status: 'failed', error: result.error })
    return { error: result.error, status: result.status }
  }

  const updated = await setItemStatus(pool, projectId, item.id, { status: 'published' })
  return { item: updated ?? item }
}
