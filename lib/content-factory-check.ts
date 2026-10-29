import type { Pool } from 'pg'
import { type ContentFactorySource, ContentFactorySourceError, recordSourceCheckResult } from './content-factory-sources.ts'
import { fetchPublicTelegramChannel } from './content-factory-telegram-source.ts'
import { storeNewSourceMessages, type ContentFactoryItem } from './content-factory-items.ts'

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
    if (source.type !== 'telegram') {
      throw new ContentFactorySourceError(`Source type "${source.type}" is not implemented yet — only "telegram" is.`)
    }
    const handle = source.handle.trim()
    const messages = await fetchPublicTelegramChannel(handle)
    const created = await storeNewSourceMessages(pool, source.projectId, source.id, messages)
    await recordSourceCheckResult(pool, source.id, source.projectId, '')
    return { created, error: '' }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not check this source.'
    await recordSourceCheckResult(pool, source.id, source.projectId, message)
    return { created: [], error: message }
  }
}
