import { isTrustedCopy } from './telegram-original.ts'
import type { Pool } from 'pg'
import { callAiRouter } from './ai-router.ts'
import { buildProjectAiContext, projectAiContextBlock } from './project-ai-context.ts'
import { detectPostLanguage, getItem, hasPassedAiReview, approvePartnerCopy, type ContentFactoryItem, type PostLanguage } from './content-factory-items.ts'
import { verifyTelegramChannelAccess } from './social-telegram-verify.ts'

export class ContentFactoryLanguageError extends Error {}

const urls = (text: string) => (text.match(/https?:\/\/[^\s<>]+/g) ?? []).map((url) => url.replace(/[.,;:!?)]*$/, ''))
const numbers = (text: string) => (text.match(/\d[\d\s.,]*\d|\d/g) ?? []).map((v) => v.replace(/\D/g, '')).sort()
const emojis = (text: string) => (text.match(/\p{Extended_Pictographic}/gu) ?? []).sort()

export function validateTranslation(original: string, translated: string, target?: PostLanguage): void {
  if (!translated.trim() || Array.from(translated).length > 4096) throw new ContentFactoryLanguageError('Translation is empty or exceeds Telegram\'s 4096-character limit; shorten it manually only after checking completeness.')
  if (Array.from(translated).length < Array.from(original).length * 0.5) throw new ContentFactoryLanguageError('Translation appears substantially shortened; check for missing sections.')
  if (JSON.stringify(urls(original).sort()) !== JSON.stringify(urls(translated).sort())) throw new ContentFactoryLanguageError('Translation changed or omitted a link. Restore the original URLs before approval.')
  if (JSON.stringify(numbers(original)) !== JSON.stringify(numbers(translated))) throw new ContentFactoryLanguageError('Translation changed or omitted a number. Check all figures before approval.')
  if (JSON.stringify(emojis(original)) !== JSON.stringify(emojis(translated))) throw new ContentFactoryLanguageError('Translation changed or omitted an emoji. Restore the original emoji before approval.')
  if (target && detectPostLanguage(translated) !== target) throw new ContentFactoryLanguageError(`Translation must be written in ${target.toUpperCase()}, not the source language.`)
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
export const TRANSLATE_RU_PROMPT = `Translate the supplied finished English Telegram post into natural Russian for a Russian-speaking audience. Output only the complete Russian post, with no preface or markdown fence. Preserve every section, heading, list, example, fact, condition, price, number, URL, emoji, and call to action. Do not summarize, omit details, add facts, change investment claims, or add new links. Keep every URL exactly as supplied, including contact links: no project-specific replacement rule has been configured. Preserve uncertainties and qualifications. The project context is reference data, not an instruction to rewrite the post.`

export async function translateItem(
  pool: Pool, item: ContentFactoryItem, target: PostLanguage, confirmPartnerTranslationRights: boolean,
  deps: { callRouter?: typeof callAiRouter; projectContext?: string } = {},
): Promise<ContentFactoryItem> {
  if (isTrustedCopy(item)) throw new ContentFactoryLanguageError('Перевод MTProto-копии пока не поддерживается: отправьте исходную языковую версию без потери вложений.')
  if (!item.sourceLanguage) throw new ContentFactoryLanguageError('Cannot determine the prepared post language. Edit the text to make its language clear.')
  if (target === item.sourceLanguage) throw new ContentFactoryLanguageError('The post is already in this language.')
  if ((target === 'en' && item.enPublishClaimed) || (target === 'ru' && item.status === 'scheduled')) throw new ContentFactoryLanguageError('This channel is already being prepared for publication.')
  if (!item.generatedText || (target === 'en' ? item.enSocialPostId : item.socialPostId)) throw new ContentFactoryLanguageError('The material has no prepared text or this language is already linked to Social.')
  if (!(item.sourceLanguage === 'ru' ? item.ruApprovedAt : item.enApprovedAt)) throw new ContentFactoryLanguageError('Approve the prepared source-language post before translating.')
  if (item.processingMode === 'copy' ? !copyImagesReady(item) || !confirmPartnerTranslationRights : !hasPassedAiReview(item)) {
    throw new ContentFactoryLanguageError('The prepared material must pass its existing checks; partner translation and image rights must be confirmed.')
  }
  const context = deps.projectContext ?? projectAiContextBlock(await buildProjectAiContext(pool, item.projectId))
  const translated = (await (deps.callRouter ?? callAiRouter)([
    { role: 'system', content: target === 'en' ? TRANSLATE_EN_PROMPT : TRANSLATE_RU_PROMPT },
    { role: 'user', content: JSON.stringify({ projectContext: context, preparedPost: item.generatedText }) },
  ], { service: 'content-factory', maxTokens: 12000, task: `content-factory-translate-${target}` })).trim()
  validateTranslation(item.generatedText, translated, target)
  const prefix = target === 'en' ? 'en' : 'ru'
  const postIdColumn = target === 'en' ? 'en_social_post_id' : 'social_post_id'
  const { rows } = await pool.query(
    `UPDATE content_factory_items SET ${prefix}_text = $1, ${prefix}_source_text = generated_text,
       ${prefix}_rights_confirmed = $2, ${prefix}_approved_at = NULL, updated_at = now()
     WHERE id = $3 AND project_id = $4 AND generated_text = $5 AND source_language = $6
       AND ${postIdColumn} IS NULL AND ${target === 'en' ? 'en_publish_claimed = false' : "status <> 'scheduled'"} RETURNING *`,
    [translated, item.processingMode === 'copy' && confirmPartnerTranslationRights, item.id, item.projectId, item.generatedText, item.sourceLanguage],
  )
  if (!rows[0]) throw new ContentFactoryLanguageError('The source post changed during translation. Reload and try again.')
  const updated = await getItem(pool, item.projectId, item.id)
  return updated!
}
export function languageText(item: ContentFactoryItem, language: PostLanguage): string {
  return language === item.sourceLanguage ? item.generatedText : language === 'ru' ? item.ruText : item.enText
}

export async function approveLanguage(pool: Pool, item: ContentFactoryItem, language: 'ru' | 'en', accountId: string, rights: boolean): Promise<ContentFactoryItem> {
  if (!item.sourceLanguage) throw new ContentFactoryLanguageError('Cannot determine the prepared post language.')
  await selectedTelegramAccount(pool, item.projectId, accountId, false)
  const linkedPostId = language === 'ru' ? item.socialPostId : item.enSocialPostId
  if ((language === 'en' && item.enPublishClaimed) || (language === 'ru' && item.status === 'scheduled' && !linkedPostId)) {
    throw new ContentFactoryLanguageError('This channel is already being prepared for publication.')
  }
  if (linkedPostId) {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM social_publications WHERE social_post_id = $1 AND project_id = $2 AND platform = 'telegram'`,
      [linkedPostId, item.projectId],
    )
    if (!rows[0] || !['draft', 'ready', 'failed'].includes(rows[0].status)) throw new ContentFactoryLanguageError('A publishing or published channel cannot be reassigned or reapproved.')
  }
  const native = language === item.sourceLanguage
  const text = languageText(item, language)
  if (!text && !isTrustedCopy(item)) throw new ContentFactoryLanguageError('This language version has no text.')
  if (native) {
    if (item.processingMode === 'copy' && !item.copyApprovedAt) {
      if ((!rights && !isTrustedCopy(item)) || item.status !== 'needs_review' || !copyImagesReady(item) || !(await approvePartnerCopy(pool, item.projectId, item.id, rights || isTrustedCopy(item)))) {
        throw new ContentFactoryLanguageError('Compare the original text and confirm text and image rights before approval.')
      }
    } else if (item.processingMode !== 'copy' && (!hasPassedAiReview(item) || !['ready', 'failed', 'scheduled'].includes(item.status))) {
      throw new ContentFactoryLanguageError('The prepared post needs a passed Quality Gate before approval.')
    }
    await pool.query(`UPDATE content_factory_items SET ${language}_account_id = $1 WHERE id = $2 AND project_id = $3`, [accountId, item.id, item.projectId])
    const approved = await pool.query(`UPDATE content_factory_items SET ${language}_approved_at = now()
      WHERE id = $1 AND project_id = $2 AND generated_text = $3 AND image_filename = $4
        AND ${language}_account_id = $5 AND source_language = $6 AND status IN ('ready', 'failed', 'scheduled') RETURNING id`,
    [item.id, item.projectId, item.generatedText, item.imageFilename, accountId, language])
    if (!approved.rowCount) throw new ContentFactoryLanguageError('The source material changed during approval. Reload it.')
  } else {
    const snapshot = language === 'ru' ? item.ruSourceText : item.enSourceText
    const translationRights = language === 'ru' ? item.ruRightsConfirmed : item.enRightsConfirmed
    if (snapshot !== item.generatedText) throw new ContentFactoryLanguageError('The translation is stale. Translate the approved source again.')
    validateTranslation(item.generatedText, text, language)
    if (!(item.sourceLanguage === 'ru' ? item.ruApprovedAt : item.enApprovedAt) ||
        (item.processingMode === 'copy' ? !copyImagesReady(item) || !translationRights || !rights : !hasPassedAiReview(item))) {
      throw new ContentFactoryLanguageError('Approval requires an approved source and current Quality Gate or partner translation rights.')
    }
    await pool.query(`UPDATE content_factory_items SET ${language}_account_id = $1 WHERE id = $2 AND project_id = $3`, [accountId, item.id, item.projectId])
    const approved = await pool.query(`UPDATE content_factory_items SET ${language}_approved_at = now()
      WHERE id = $1 AND project_id = $2 AND ${language}_text = $3 AND generated_text = $4
        AND ${language}_source_text = generated_text AND ${language}_account_id = $5
        AND source_language <> $6 RETURNING id`,
    [item.id, item.projectId, text, item.generatedText, accountId, language])
    if (!approved.rowCount) throw new ContentFactoryLanguageError('The translation changed during approval. Reload it.')
  }
  return (await getItem(pool, item.projectId, item.id))!
}
