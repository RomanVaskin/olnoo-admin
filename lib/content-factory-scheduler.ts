import type { Pool } from 'pg'
import { checkSourceNow } from './content-factory-check.ts'

// Контент-завод — background sweep, first working stage. Pool-injected, no `@/` imports.
//
// What this DOES: periodically checks every enabled source across every project
// ("периодическая проверка источников", "сохранение новых сообщений") and stores any genuinely
// new messages — `storeNewSourceMessages`'s own DB-level `UNIQUE (source_id, external_id)` is
// what guarantees no duplicate is ever created, so a repeated sweep (or an overlapping manual
// "Проверить сейчас" click) is always safe to run again. One source's failure (bad handle,
// Telegram preview unavailable, a network error) never stops the sweep over the rest —
// `checkSourceNow` always records the failure on that source's own row and moves on.
//
// What this DELIBERATELY DOES NOT do yet, in this first working stage: automatically generate or
// publish anything, even for a project whose Automation settings (lib/content-factory-settings.ts)
// are set to `auto_review` or `auto_publish`. Those settings are real, stored, and already
// enforced wherever they matter (`autoPublish` always defaults to `false`, never flipped
// automatically — task requirement "Не включай автопубликацию по умолчанию"), but this sweep only
// ever reads sources into the queue; running generation unattended means spending real AI Router
// money on an unauthenticated route with no rate limiting (this whole app currently has no auth
// layer — see this route's own HTTP handler and OLNOO_PROJECT_MAP.md), and running publication
// unattended means risking exactly the kind of unreviewed claim (price/yield/legislation/
// investment) the task explicitly asks to gate on manual approval before anything auto-executes.
// Wiring real automatic generation/publishing is the documented next step, not this one — see
// OLNOO_PROJECT_MAP.md's "Контент-завод" section for exactly what's needed first (real auth on
// these routes, a spend cap, a daily-publish-count enforcement point) before it would be safe to
// turn on by default.

export type SchedulerSourceResult = { sourceId: string; projectId: number; createdCount: number; error: string }

export async function runContentFactorySourceSweep(pool: Pool): Promise<SchedulerSourceResult[]> {
  const { rows } = await pool.query<{ id: string; project_id: number; type: string; handle: string; enabled: boolean; last_checked_at: string | null; last_error: string; created_at: string; updated_at: string }>(
    `SELECT * FROM content_factory_sources WHERE enabled = true`,
  )
  const results: SchedulerSourceResult[] = []
  for (const row of rows) {
    const source = {
      id: row.id,
      projectId: row.project_id,
      type: row.type as 'telegram' | 'rss' | 'website' | 'youtube',
      handle: row.handle,
      enabled: row.enabled,
      lastCheckedAt: row.last_checked_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    const { created, error } = await checkSourceNow(pool, source)
    results.push({ sourceId: source.id, projectId: source.projectId, createdCount: created.length, error })
  }
  return results
}
