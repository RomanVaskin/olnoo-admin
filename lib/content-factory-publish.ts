import { isTrustedCopy } from './telegram-original.ts'
import { claimTelegramOrigin } from './content-factory-automation.ts'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { createSocialPost, getSocialPost } from '@/lib/social'
import { publishSocialPublicationToTelegram } from '@/lib/social-telegram'
import { getItem, setItemSocialPostId, setItemStatus, canPublish, hasPassedAiReview, hasApprovedPartnerCopy, claimPartnerCopyPublish, type ContentFactoryItem } from '@/lib/content-factory-items'
import { telegramPublicationOutcome } from './content-factory-publish-outcome.ts'
import { readContentFactoryCover } from './content-factory-image.ts'
import { copyImagesReady, selectedTelegramAccount, languageText } from './content-factory-languages.ts'

// Контент-завод hands each approved language to the existing Social module. RU and EN use
// separate Social posts and publication rows, so their statuses and atomic send claims stay
// independent; neither language adds a new Telegram send path.
//
// Uses the shared `@/lib/db` pool directly (not pool-injected) — the same posture
// lib/social-publications.ts already has, since it glues into lib/social.ts/lib/social-telegram.ts
// which are themselves written against that shared pool, not a testable injected one.

export class ContentFactoryPublishError extends Error {}

/**
 * Publishes one approved language to an explicitly selected Telegram account, via the existing
 * Social module end to end. Project isolation is enforced the same way every other
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
export async function publishContentFactoryItem(projectSlug: string, itemId: string, language: 'ru' | 'en' = 'ru'): Promise<{ error: string; status: number } | { item: ContentFactoryItem }> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const item = await getItem(pool, projectId, itemId)
  if (!item) return { error: 'not found', status: 404 }

  if (language === 'en') return publishEnglishItem(projectSlug, item)
  const ruText = languageText(item, 'ru')
  const translated = item.sourceLanguage === 'en'
  if (!item.ruApprovedAt || !item.ruAccountId) return { error: 'Approve the Russian version and choose its Telegram channel first.', status: 409 }
  try { await selectedTelegramAccount(pool, projectId, item.ruAccountId, true) }
  catch (error) { return { error: error instanceof Error ? error.message : 'Channel verification failed.', status: 409 } }

  const isCopy = item.processingMode === 'copy'
  if (!item.socialPostId && !canPublish(item.status) && item.status !== 'failed') {
    return { error: `Item is not ready to publish (status: ${item.status}). Approve it first.`, status: 409 }
  }
  if (!ruText.trim() && !isTrustedCopy(item)) {
    return { error: 'This item has no prepared text yet — generate one first.', status: 400 }
  }
  if (isCopy ? !hasApprovedPartnerCopy(item) : !hasPassedAiReview(item)) {
    return { error: isCopy ? 'Partner copy requires confirmed rights and manual approval of the unchanged original text.' : 'A successful AI review of the current material is required before publication.', status: 409 }
  }
  if (translated && (item.ruSourceText !== item.generatedText || (isCopy && !item.ruRightsConfirmed))) {
    return { error: 'The Russian translation is stale or partner translation rights are missing.', status: 409 }
  }
  if (isCopy && item.generatedText !== item.originalText) {
    return { error: 'Partner text differs from the approved source preview. Publication is blocked.', status: 409 }
  }
  if (isCopy && !isTrustedCopy(item) && Array.from(ruText).length > 4096) {
    return { error: 'The Russian text exceeds Telegram\'s 4096-character limit.', status: 422 }
  }

  let photo: Buffer | undefined
  if (item.imageFilename && !isCopy) {
    try {
      photo = await readContentFactoryCover(projectSlug, item.imageFilename)
    } catch {
      return { error: 'The generated image is unavailable. Regenerate or delete it before publishing.', status: 500 }
    }
  }

  if (!await claimTelegramOrigin(pool, item)) return { error: 'Это исходное сообщение уже связано с другим материалом проекта. Проверьте историю дубликатов.', status: 409 }

  let socialPostId = item.socialPostId
  if (!socialPostId) {
    if (isCopy && !(await claimPartnerCopyPublish(pool, projectId, item.id))) {
      return { error: 'This partner copy is already being published or has changed.', status: 409 }
    }
    if (!isCopy) {
      const claim = await pool.query(`UPDATE content_factory_items SET status = 'scheduled' WHERE id = $1 AND project_id = $2
        AND status IN ('ready', 'failed') AND social_post_id IS NULL AND ru_approved_at IS NOT NULL RETURNING id`, [item.id, projectId])
      if (!claim.rowCount) return { error: 'Russian publication is already being prepared.', status: 409 }
    }
    let created: Awaited<ReturnType<typeof createSocialPost>>
    try {
      created = await createSocialPost(projectSlug, {
        topic: item.generatedTitle || 'Content Factory',
        body: ruText,
        channels: ['telegram'],
        status: 'ready',
      })
    } catch (err) {
      await setItemStatus(pool, projectId, item.id, { status: 'failed', error: 'Could not create the Social post.' })
      throw err
    }
    if ('error' in created) {
      await setItemStatus(pool, projectId, item.id, { status: 'failed', error: created.error })
      return { error: created.error, status: created.status }
    }
    socialPostId = created.row.id as string
    await setItemSocialPostId(pool, projectId, item.id, socialPostId)
  }

  const post = await getSocialPost(socialPostId, projectSlug)
  if (!post) return { error: 'the linked post could not be found', status: 404 }

  const { rows: pubRows } = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM social_publications WHERE social_post_id = $1 AND project_id = $2 AND platform = 'telegram'`,
    [socialPostId, projectId],
  )
  const publicationId = pubRows[0]?.id
  if (!publicationId) return { error: 'no Telegram publication row exists for this post', status: 500 }
  if (pubRows[0].status === 'published') return { item }
  if (pubRows[0].status === 'publishing') return { error: 'Telegram send is unconfirmed; inspect the channel before any retry.', status: 409 }

  const ruTarget = await pool.query(`UPDATE social_publications SET social_account_id = $1 WHERE id = $2 AND project_id = $3 AND status IN ('draft', 'ready', 'failed') RETURNING id`, [item.ruAccountId, publicationId, projectId])
  if (!ruTarget.rowCount) return { error: 'Russian publication is no longer editable.', status: 409 }

  await setItemStatus(pool, projectId, item.id, { status: 'scheduled' })

  const result = await publishSocialPublicationToTelegram(pool, publicationId, projectSlug, photo)
  const outcome = telegramPublicationOutcome(result)
  if (!outcome.published) {
    // Left as 'failed' rather than reverting to 'ready' so the queue makes the problem visible;
    // `socialPostId` is already set at this point, so a retry click bypasses the status gate
    // above entirely and simply calls `publishSocialPublicationToTelegram` again on the same
    // publication row. The publisher permits retrying a confirmed failure but refuses a
    // concurrent or unconfirmed send while its row remains 'publishing'.
    await setItemStatus(pool, projectId, item.id, { status: 'failed', error: outcome.error })
    return { error: outcome.error, status: outcome.status }
  }

  const updated = await setItemStatus(pool, projectId, item.id, { status: 'published' })
  return { item: updated ?? item }
}

async function publishEnglishItem(projectSlug: string, item: ContentFactoryItem): Promise<{ error: string; status: number } | { item: ContentFactoryItem }> {
  const projectId = item.projectId
  const enText = languageText(item, 'en')
  const translated = item.sourceLanguage === 'ru'
  if (!item.enApprovedAt || !item.enAccountId || (!enText && !isTrustedCopy(item)) ||
      (translated && (item.enSourceText !== item.generatedText || (item.processingMode === 'copy' && !item.enRightsConfirmed))) ||
      (item.processingMode === 'copy' ? !copyImagesReady(item) || !hasApprovedPartnerCopy(item) : !hasPassedAiReview(item))) {
    return { error: 'Approve the current English version and its rights before publishing.', status: 409 }
  }
  try { await selectedTelegramAccount(pool, projectId, item.enAccountId, true) }
  catch (error) { return { error: error instanceof Error ? error.message : 'Channel verification failed.', status: 409 } }

  if (!await claimTelegramOrigin(pool, item)) return { error: 'Это исходное сообщение уже связано с другим материалом проекта. Проверьте историю дубликатов.', status: 409 }
  let socialPostId = item.enSocialPostId
  if (!socialPostId) {
    const claim = await pool.query(`UPDATE content_factory_items SET en_publish_claimed = true
      WHERE id = $1 AND project_id = $2 AND en_publish_claimed = false AND en_social_post_id IS NULL
        AND en_approved_at IS NOT NULL RETURNING id`, [item.id, projectId])
    if (!claim.rowCount) return { error: 'English publication is already being prepared. Reload its status.', status: 409 }
    try {
      const created = await createSocialPost(projectSlug, {
        topic: item.generatedTitle || 'Content Factory EN', body: enText, channels: ['telegram'], status: 'ready',
      })
      if ('error' in created) throw new ContentFactoryPublishError(created.error)
      socialPostId = created.row.id as string
      await pool.query(`UPDATE content_factory_items SET en_social_post_id = $1 WHERE id = $2 AND project_id = $3 AND en_publish_claimed = true`, [socialPostId, item.id, projectId])
    } catch (error) {
      await pool.query(`UPDATE content_factory_items SET en_publish_claimed = false WHERE id = $1 AND project_id = $2 AND en_social_post_id IS NULL`, [item.id, projectId])
      return { error: error instanceof Error ? error.message : 'Could not prepare English Social post.', status: 500 }
    }
  }
  const { rows } = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM social_publications WHERE social_post_id = $1 AND project_id = $2 AND platform = 'telegram'`, [socialPostId, projectId],
  )
  const publicationId = rows[0]?.id
  if (!publicationId) return { error: 'English Telegram publication is missing.', status: 500 }
  if (rows[0].status === 'published') return { item: (await getItem(pool, projectId, item.id)) ?? item }
  if (rows[0].status === 'publishing') return { error: 'English Telegram send is unconfirmed; inspect the channel before any retry.', status: 409 }
  const enTarget = await pool.query(`UPDATE social_publications SET social_account_id = $1 WHERE id = $2 AND project_id = $3 AND status IN ('draft', 'ready', 'failed') RETURNING id`, [item.enAccountId, publicationId, projectId])
  if (!enTarget.rowCount) return { error: 'English publication is no longer editable.', status: 409 }
  const result = await publishSocialPublicationToTelegram(pool, publicationId, projectSlug)
  const outcome = telegramPublicationOutcome(result)
  if (!outcome.published) return { error: outcome.error, status: outcome.status }
  return { item: (await getItem(pool, projectId, item.id)) ?? item }
}
