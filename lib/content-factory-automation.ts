import type { Pool } from 'pg'
import { getItem, setGeneratedContent, setItemStatus, claimAiReview, finishAiReview, hasPassedAiReview, type ContentFactoryItem } from './content-factory-items.ts'
import { generateContentFactoryArticle } from './content-factory-generate.ts'
import { reviewContentFactoryItem } from './content-factory-review.ts'
import { approveLanguage } from './content-factory-languages.ts'
import type { ContentFactorySource } from './content-factory-sources.ts'

/** Conservative routing signal, NOT a fact check: source assertions are not verification. */
export function needsAutomationEditor(item: ContentFactoryItem): boolean {
  return !!item.reviewReason.trim() || item.aiReview?.risk !== 'low' || !hasPassedAiReview(item)
    || /(?:\d[\d\s.,]*\s*(?:%|₽|€|\$|руб|usd|eur)|доходност|инвести|ипотек|закон|юридич|гарантир|yield|invest|mortgage|legislation|guaranteed)/iu.test(item.generatedText)
}

export class AutomationClaimConflict extends Error {}

/** Uses the existing two-stage generator, JSON parser and independent Quality Gate.
 * Every retry is budgeted by the scheduler before this function is called.
 */
export async function prepareAutomationItem(pool: Pool, item: ContentFactoryItem): Promise<ContentFactoryItem> {
  const claim = await pool.query(`UPDATE content_factory_items SET status = 'processing', updated_at = now()
    WHERE id = $1 AND project_id = $2 AND status IN ('new','failed') AND generated_text = ''
      AND social_post_id IS NULL AND en_social_post_id IS NULL AND en_publish_claimed = false RETURNING id`, [item.id, item.projectId])
  if (!claim.rowCount) throw new AutomationClaimConflict('Материал изменён или уже обрабатывается.')
  const generated = await generateContentFactoryArticle(pool, item.projectId, { sourceText: item.originalText, sourceUrl: item.originalUrl })
  // This automation contract explicitly requires the provenance link in AI posts.
  const body = `${generated.body}\n\nИсточник: ${item.originalUrl}`
  if (Array.from(body).length > 4000) throw new Error('Текст со ссылкой превышает лимит Telegram; требуется редактор.')
  const saved = await setGeneratedContent(pool, item.projectId, item.id, { title: generated.title, text: body, status: 'needs_review', reviewReason: generated.reviewReason || (generated.needsReview ? 'Генератор требует проверки.' : '') })
  if (!saved) throw new Error('Материал изменён во время генерации.')
  const reviewing = await claimAiReview(pool, saved.projectId, saved.id)
  if (!reviewing) throw new Error('Материал изменён перед проверкой.')
  const snapshot = { title: reviewing.generatedTitle, text: reviewing.generatedText, imageFilename: reviewing.imageFilename, claimId: reviewing.aiReview!.claimId! }
  try {
    const review = await reviewContentFactoryItem(pool, reviewing)
    const finished = await finishAiReview(pool, item.projectId, item.id, snapshot, review)
    if (!finished) throw new Error('Материал изменён во время проверки.')
    return finished
  } catch {
    await finishAiReview(pool, item.projectId, item.id, snapshot, { status: 'error', passed: false, error: 'Автоматическая AI-проверка не завершена; публикация заблокирована.' })
    throw new Error('AI-проверка не завершена; требуется редактор.')
  }
}

export async function approveAutomationItem(pool: Pool, source: ContentFactorySource, item: ContentFactoryItem): Promise<ContentFactoryItem> {
  if (item.processingMode === 'copy' || needsAutomationEditor(item) || !item.sourceLanguage) throw new Error('Требуется ручное согласование.')
  const ready = await setItemStatus(pool, item.projectId, item.id, { status: 'ready' })
  if (!ready) throw new Error('Материал изменён перед согласованием.')
  return approveLanguage(pool, ready, ready.sourceLanguage!, source.automation!.accountId!, false)
}

/** Shared by manual and automatic Content Factory publication. Once a Telegram origin has
 * been claimed, all duplicate source rows must reuse that item, even across process restarts.
 */
export async function claimTelegramOrigin(pool: Pool, item: ContentFactoryItem): Promise<boolean> {
  const match = /^https:\/\/t\.me\/([a-z0-9_]{5,32})\/(\d+)\/?$/i.exec(item.originalUrl)
  if (item.originKind === 'own' || !match) return true
  const key = `${match[1].toLowerCase()}/${BigInt(match[2])}`
  try {
    const result = await pool.query(`UPDATE content_factory_items i SET automation_message_key = $1
      WHERE i.id = $2 AND i.project_id = $3
        AND NOT EXISTS (SELECT 1 FROM content_factory_items other WHERE other.project_id = i.project_id
          AND other.id <> i.id AND lower(other.original_url) = lower(i.original_url)
          AND (other.social_post_id IS NOT NULL OR other.en_social_post_id IS NOT NULL)) RETURNING id`, [key, item.id, item.projectId])
    return !!result.rowCount
  } catch (e) { if ((e as { code?: string }).code === '23505') return false; throw e }
}
