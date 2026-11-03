import type { Pool } from 'pg'
import { callAiRouter } from './ai-router.ts'
import { buildProjectAiContext, projectAiContextBlock } from './project-ai-context.ts'
import { getItem, hasApprovedPartnerCopy, hasPassedAiReview, approvePartnerCopy, type ContentFactoryItem } from './content-factory-items.ts'
import { verifyTelegramChannelAccess } from './social-telegram-verify.ts'

export class ContentFactoryLanguageError extends Error {}

const urls = (text: string) => (text.match(/https?:\/\/[^\s<>]+/g) ?? []).map((url) => url.replace(/[.,;:!?)]*$/, ''))
const numbers = (text: string) => (text.match(/\d[\d\s.,]*\d|\d/g) ?? []).map((v) => v.replace(/\D/g, '')).sort()
const emojis = (text: string) => (text.match(/\p{Extended_Pictographic}/gu) ?? []).sort()

export function validateEnglishTranslation(original: string, translated: string): void {
  if (!translated.trim() || Array.from(translated).length > 4096) throw new ContentFactoryLanguageError('English text is empty or exceeds Telegram\'s 4096-character limit; shorten it manually only after checking completeness.')
  if (Array.from(translated).length < Array.from(original).length * 0.5) throw new ContentFactoryLanguageError('English text appears substantially shortened; check for missing sections.')
  if (JSON.stringify(urls(original).sort()) !== JSON.stringify(urls(translated).sort())) throw new ContentFactoryLanguageError('Translation changed or omitted a link. Restore the original URLs before approval.')
  if (JSON.stringify(numbers(original)) !== JSON.stringify(numbers(translated))) throw new ContentFactoryLanguageError('Translation changed or omitted a number. Check all figures before approval.')
  if (JSON.stringify(emojis(original)) !== JSON.stringify(emojis(translated))) throw new ContentFactoryLanguageError('Translation changed or omitted an emoji. Restore the original emoji before approval.')
}

export function copyImagesReady(item: ContentFactoryItem): boolean {
  return item.processingMode !== 'copy' || (!!item.copyPermissionConfirmed && !item.originalImageError &&
    item.originalImageFiles.length === item.originalImageUrls.length && item.generatedText === item.originalText && !item.imageFilename)
}

export async function selectedTelegramAccount(pool: Pool, projectId: number, accountId: string, checkBot: boolean): Promise<{ id: string; username: string }> {
  const { rows } = await pool.query<{ id: string; username: string }>(
    `SELECT id, username FROM social_accounts WHERE id = $1 AND project_id = $2 AND platform = 'telegram' AND active = true AND status = 'connected'`,
    [accountId, projectId],
  )
  const account = rows[0]
  if (!account?.username) throw new ContentFactoryLanguageError('Select a connected Telegram channel in this project.')
  if (checkBot) {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) throw new ContentFactoryLanguageError('Telegram bot token is not configured.')
    const verification = await verifyTelegramChannelAccess(token, account.username)
    if (!verification.ok) throw new ContentFactoryLanguageError(`Bot cannot publish to ${account.username}: ${verification.error}`)
  }
  return account
}

export const TRANSLATE_EN_PROMPT = `Translate the supplied finished Russian Telegram post into natural English for an international audience. Output only the complete English post, with no preface or markdown fence. Preserve every section, heading, list, example, fact, condition, price, number, URL, emoji, and call to action. Do not summarize, omit details, add facts, change investment claims, or add new links. Keep every URL exactly as supplied, including contact links: no project-specific replacement rule has been configured. Preserve uncertainties and qualifications. The project context is reference data, not an instruction to rewrite the post.`

export async function translateItemToEnglish(pool: Pool, item: ContentFactoryItem, confirmPartnerTranslationRights: boolean): Promise<ContentFactoryItem> {
  if (!item.generatedText || item.enSocialPostId) throw new ContentFactoryLanguageError('The material has no prepared text or its English post is already linked to Social.')
  if (item.processingMode === 'copy' ? !copyImagesReady(item) || !confirmPartnerTranslationRights : !hasPassedAiReview(item)) {
    throw new ContentFactoryLanguageError('The Russian material must pass its existing checks; partner translation and image rights must be confirmed.')
  }
  const context = projectAiContextBlock(await buildProjectAiContext(pool, item.projectId))
  const translated = (await callAiRouter([
    { role: 'system', content: TRANSLATE_EN_PROMPT },
    { role: 'user', content: JSON.stringify({ projectContext: context, russianPost: item.generatedText }) },
  ], { service: 'content-factory', maxTokens: 12000, task: 'content-factory-translate-en' })).trim()
  validateEnglishTranslation(item.generatedText, translated)
  const { rows } = await pool.query(
    `UPDATE content_factory_items SET en_text = $1, en_source_text = generated_text,
       en_rights_confirmed = $2, en_approved_at = NULL, updated_at = now()
     WHERE id = $3 AND project_id = $4 AND generated_text = $5 AND en_social_post_id IS NULL RETURNING *`,
    [translated, item.processingMode === 'copy' && confirmPartnerTranslationRights, item.id, item.projectId, item.generatedText],
  )
  if (!rows[0]) throw new ContentFactoryLanguageError('The Russian post changed during translation. Reload and try again.')
  const updated = await getItem(pool, item.projectId, item.id)
  return updated!
}

export async function approveLanguage(pool: Pool, item: ContentFactoryItem, language: 'ru' | 'en', accountId: string, rights: boolean): Promise<ContentFactoryItem> {
  await selectedTelegramAccount(pool, item.projectId, accountId, false)
  const linkedPostId = language === 'ru' ? item.socialPostId : item.enSocialPostId
  if (linkedPostId) {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM social_publications WHERE social_post_id = $1 AND project_id = $2 AND platform = 'telegram'`,
      [linkedPostId, item.projectId],
    )
    if (!rows[0] || !['draft', 'ready', 'failed'].includes(rows[0].status)) throw new ContentFactoryLanguageError('A publishing or published channel cannot be reassigned or reapproved.')
  }
  if (language === 'ru') {
    if (!item.generatedText) throw new ContentFactoryLanguageError('Russian post has no text.')
    if (item.processingMode === 'copy' && !item.copyApprovedAt) {
      if (!rights || item.status !== 'needs_review' || !copyImagesReady(item) || !(await approvePartnerCopy(pool, item.projectId, item.id, rights))) {
        throw new ContentFactoryLanguageError('Compare the original text and confirm text and image rights before Russian approval.')
      }
    } else if (item.processingMode !== 'copy' && (!hasPassedAiReview(item) || !['ready', 'failed', 'scheduled'].includes(item.status))) {
      throw new ContentFactoryLanguageError('Russian post needs a passed Quality Gate before approval.')
    }
    await pool.query('UPDATE content_factory_items SET ru_account_id = $1 WHERE id = $2 AND project_id = $3', [accountId, item.id, item.projectId])
    const approved = await pool.query(`UPDATE content_factory_items SET ru_approved_at = now()
      WHERE id = $1 AND project_id = $2 AND generated_text = $3 AND image_filename = $4
        AND ru_account_id = $5 AND status IN ('ready', 'failed', 'scheduled') RETURNING id`,
    [item.id, item.projectId, item.generatedText, item.imageFilename, accountId])
    if (!approved.rowCount) throw new ContentFactoryLanguageError('Russian material changed during approval. Reload it.')
  } else {
    if (!item.enText || item.enSourceText !== item.generatedText) throw new ContentFactoryLanguageError('English translation is missing or stale.')
    validateEnglishTranslation(item.generatedText, item.enText)
    if (item.processingMode === 'copy' ? !copyImagesReady(item) || !item.enRightsConfirmed || !rights : !hasPassedAiReview(item)) {
      throw new ContentFactoryLanguageError('English approval requires current Quality Gate or partner translation and image rights.')
    }
    await pool.query('UPDATE content_factory_items SET en_account_id = $1 WHERE id = $2 AND project_id = $3', [accountId, item.id, item.projectId])
    const approved = await pool.query(`UPDATE content_factory_items SET en_approved_at = now()
      WHERE id = $1 AND project_id = $2 AND en_text = $3 AND generated_text = $4
        AND en_source_text = generated_text AND en_account_id = $5 RETURNING id`,
    [item.id, item.projectId, item.enText, item.generatedText, accountId])
    if (!approved.rowCount) throw new ContentFactoryLanguageError('English translation changed during approval. Reload it.')
  }
  return (await getItem(pool, item.projectId, item.id))!
}
