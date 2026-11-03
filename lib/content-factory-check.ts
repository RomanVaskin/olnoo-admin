import type { Pool } from 'pg'
import { type ContentFactorySource, ContentFactorySourceError, recordSourceCheckResult } from './content-factory-sources.ts'
import { fetchPublicTelegramChannel, normalizeTelegramHandle } from './content-factory-telegram-source.ts'
import { storeNewSourceMessages, type ContentFactoryItem } from './content-factory-items.ts'
import { fetchWebsiteSource } from './content-factory-website-source.ts'
import { fetchRssSource } from './content-factory-rss-source.ts'
import { syncOriginalImages } from './content-factory-original-images.ts'

// Контент-завод — "Проверить сейчас" / periodic sweep. Pool-injected, no `@/` imports.
//
// One source at a time: fetches via the adapter for its `type`, stores only the messages not
// already known (storeNewSourceMessages's own DB-level UNIQUE constraint is what actually
// guarantees no duplicate — this function doesn't need to diff anything itself), and always
// records the outcome on the source row (recordSourceCheckResult) — success or failure — so
// "Последняя проверка" / "Статус" on the Sources screen is always current, and a broken source
// never silently goes stale-looking. Never throws: a failure (adapter error, unsupported type,
// network failure) is recorded as the source's own `lastError` and an empty item list is
// returned, so one bad source can never stop a multi-source sweep (see
// lib/content-factory-scheduler.ts) or crash the single-source "Проверить сейчас" button.
export async function checkSourceNow(pool: Pool, source: ContentFactorySource): Promise<{ created: ContentFactoryItem[]; error: string }> {
  try {
    if (source.type === 'rss' || source.type === 'website') {
      if (source.processingMode !== 'ai') throw new ContentFactorySourceError('RSS and websites support AI processing only.')
      const created = await storeNewSourceMessages(pool, source.projectId, source.id, await (source.type === 'rss' ? fetchRssSource : fetchWebsiteSource)(source.handle))
      await recordSourceCheckResult(pool, source.id, source.projectId, '')
      return { created, error: '' }
    }
    if (source.type !== 'telegram') {
      throw new ContentFactorySourceError(`Source type "${source.type}" is not implemented yet — only "telegram" is.`)
    }
    const handle = normalizeTelegramHandle(source.handle)
    if (!handle) {
      throw new ContentFactorySourceError('Invalid Telegram channel address. Use a channel username, @username, or https://t.me/username.')
    }
    const messages = await fetchPublicTelegramChannel(handle)
    const created = await storeNewSourceMessages(pool, source.projectId, source.id, messages, {
      processingMode: source.processingMode, copyPermissionConfirmed: source.copyPermissionConfirmed,
    })
    let imageError = ''
    if (source.processingMode === 'copy') {
      for (const item of created) {
        if (item.processingMode === 'copy' && item.originalImageUrls.length) {
          const error = await syncOriginalImages(pool, item)
          if (!imageError) imageError = error
        }
      }
    }
    await recordSourceCheckResult(pool, source.id, source.projectId, imageError)
    return { created, error: imageError }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not check this source.'
    await recordSourceCheckResult(pool, source.id, source.projectId, message)
    return { created: [], error: message }
  }
}
