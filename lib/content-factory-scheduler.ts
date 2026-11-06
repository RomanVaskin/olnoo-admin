import { isTrustedCopy } from './telegram-original.ts'
import type { Pool } from 'pg'
import { checkSourceNow } from './content-factory-check.ts'
import { sourceFromRow, type ContentFactorySource } from './content-factory-sources.ts'
import { getItem, setItemStatus, type ContentFactoryItem } from './content-factory-items.ts'
import { selectedTelegramAccount } from './content-factory-languages.ts'
import { AutomationClaimConflict, prepareAutomationItem, approveAutomationItem, approveMonitorCopy, needsAutomationEditor } from './content-factory-automation.ts'

export type SchedulerSourceResult = { sourceId: string; projectId: number; createdCount: number; error: string; operation?: string }
type Publish = (project: string, id: string, language: 'ru' | 'en') => Promise<{ error: string; status: number } | { item: ContentFactoryItem }>
export type AutomationDeps = {
  enabled: boolean; publish: Publish; check?: typeof checkSourceNow; verify?: typeof selectedTelegramAccount;
  prepare?: typeof prepareAutomationItem; approve?: typeof approveAutomationItem; now?: () => Date
}

/** Existing source sweep, protected route, same DB and Social publisher. Per-project session
 * lock is held on ONE connection and shared with settings writes (transaction lock 78216).
 */
export async function runContentFactorySourceSweep(pool: Pool, deps?: AutomationDeps): Promise<SchedulerSourceResult[]> {
  const { rows } = await pool.query(`SELECT s.*, p.slug AS project_slug FROM content_factory_sources s
    JOIN projects p ON p.id = s.project_id WHERE s.enabled = true AND p.archived_at IS NULL
    AND s.handle NOT LIKE 'own-bot:%' ORDER BY s.project_id, s.id`)
  const results: SchedulerSourceResult[] = []
  for (const row of rows) {
    const lock = await pool.connect()
    let held = false
    try {
      held = (await lock.query('SELECT pg_try_advisory_lock(78216, $1) AS locked', [row.project_id])).rows[0]?.locked === true
      if (!held) continue
      // Re-read after locking; a concurrent settings change must take effect before work starts.
      const current = await pool.query('SELECT * FROM content_factory_sources WHERE id = $1 AND project_id = $2 AND enabled = true', [row.id, row.project_id])
      if (!current.rows[0]) continue
      const source = sourceFromRow(current.rows[0])
      const now = deps?.now?.() ?? new Date()
      const started = source.automationRuntime?.lastStartedAt ?? source.lastCheckedAt
      if (source.type === 'telegram' && started && Math.floor(now.getTime() / 600_000) <= Math.floor(new Date(started).getTime() / 600_000)) continue
      if (source.type === 'telegram') {
        source.automationRuntime = { ...source.automationRuntime, lastStartedAt: now.toISOString() }
        await pool.query('UPDATE content_factory_sources SET automation_runtime = $1::jsonb WHERE id = $2 AND project_id = $3 AND automation_revision = $4', [JSON.stringify(source.automationRuntime), source.id, source.projectId, source.automationRevision])
      }
      source.monitorBaseline = !!deps?.enabled && source.automation?.mode !== 'manual' && !source.automationRuntime?.since
      const result = await (deps?.check ?? checkSourceNow)(pool, source)
      const entry: SchedulerSourceResult = { sourceId: source.id, projectId: source.projectId, createdCount: result.created.length, error: result.error }
      results.push(entry)
      if (!deps?.enabled || source.type !== 'telegram' || source.automation?.mode === 'manual') continue
      const state = { ...source.automationRuntime }
      async function save(operation: string, error = '') {
        state.operation = operation; state.error = error; state.checkedAt = now.toISOString()
        entry.operation = operation; entry.error = error
        await pool.query('UPDATE content_factory_sources SET automation_runtime = $1::jsonb WHERE id = $2 AND project_id = $3 AND automation_revision = $4', [JSON.stringify(state), source.id, source.projectId, source.automationRevision])
      }
      try {
        if (state.monitorRetryAt && new Date(state.monitorRetryAt).getTime()>now.getTime()) { await save('waiting','Telegram временно ограничил запросы; повтор после разрешённого срока.'); continue }
        if (state.paused) { await save('paused', String(state.error ?? 'Автоматизация остановлена. Пересохраните настройки после проверки.')); continue }
        const duplicates = await pool.query(`SELECT id FROM content_factory_sources WHERE project_id = $1 AND type = 'telegram' AND enabled = true
          AND content_factory_telegram_key(handle) = content_factory_telegram_key($2) AND id <> $3`, [source.projectId, source.handle, source.id])
        if (duplicates.rows.length) { state.paused = true; await save('paused', 'Включены дубликаты источника. Отключите лишние строки, сохранив их историю.'); continue }
        if (result.error && !result.observedMaxId) throw new Error('Источник временно недоступен. Смотрите последнюю ошибку сбора.')
        if (!state.since) {
          // First successful snapshot is a high-water mark, never a backfill/publication trigger.
          state.since = now.toISOString(); state.cursor = result.observedMaxId ?? '0'
          if (state.cursor === '0' && source.automation?.transport !== 'monitor') { delete state.since; await save('waiting', 'Нет сообщений для безопасной начальной границы.'); continue }
          await save('baseline'); continue
        }
        // Only newly observed IDs after arming. Source mode/target snapshot is immutable per item.
        await pool.query(`UPDATE content_factory_items SET automation = $1::jsonb
          WHERE project_id = $2 AND source_id = $3 AND external_id ~ '^[0-9]+$'
            AND CASE WHEN external_id ~ '^[0-9]+$' THEN external_id::numeric ELSE 0 END > $4::numeric
            AND created_at >= $5::timestamptz AND (original_telegram='{}'::jsonb OR original_telegram->>'complete'='true') AND automation = '{}'::jsonb
            AND social_post_id IS NULL AND en_social_post_id IS NULL`,
          [JSON.stringify({ ...source.automation, revision: source.automationRevision, status: 'pending', attempts: 0 }), source.projectId, source.id, state.cursor, state.since])
        if (result.observedMaxId && BigInt(result.observedMaxId) > BigInt(String(state.cursor))) state.cursor = result.observedMaxId
        await save('collected')
        const pending = await pool.query(`SELECT id, automation FROM content_factory_items WHERE project_id = $1 AND source_id = $2
          AND automation->>'revision' = $3 AND automation->>'status' IN ('pending','failed','processing','publishing','send_retry') ORDER BY created_at, id LIMIT 20`, [source.projectId, source.id, source.automationRevision])
        if (!pending.rows[0]) continue
        for (const job of pending.rows) {
          if (state.paused) break
          const policy = job.automation as Record<string, any>
          let item = await getItem(pool, source.projectId, job.id)
          if (!item) continue
          async function jobState(status: string, error = '') {
            policy.status = status; policy.error = error
            await pool.query('UPDATE content_factory_items SET automation = $1::jsonb WHERE id = $2 AND project_id = $3', [JSON.stringify(policy), job.id, source.projectId])
            await save(status, error)
          }
          if (policy.status === 'publishing') {
            const publications = await pool.query(`SELECT status FROM social_publications WHERE project_id = $1 AND platform = 'telegram'
              AND social_post_id = $2`, [item.projectId, item.sourceLanguage === 'en' ? item.enSocialPostId : item.socialPostId])
            if (publications.rows[0]?.status === 'published') { await jobState('published'); continue }
            state.paused = true; await jobState('uncertain', 'Процесс прерван во время отправки. Проверьте канал и Social; автоматического повтора нет.'); continue
          }
          if (policy.status === 'processing') { await setItemStatus(pool, item.projectId, item.id, { status: item.generatedText ? 'needs_review' : 'failed', error: 'Автоматическая обработка прервана; проверьте материал.' }); await jobState('review', 'Процесс прерван во время AI-обработки; требуется редактор, платный вызов не повторён.'); continue }
          try { await (deps.verify ?? selectedTelegramAccount)(pool, item.projectId, policy.accountId, true) }
          catch { state.paused = true; await jobState('review', 'Канал назначения недоступен боту. Проверьте подключение и права, затем пересохраните настройки.'); continue }
          if (policy.status !== 'send_retry' && (item.ruApprovedAt || item.enApprovedAt || item.status === 'rejected')) {
            await jobState('review', 'Материал уже согласован или отклонён вручную; выбранный пользователем канал не изменён.'); continue
          }
          // Preview text/photo completeness cannot be certified from public HTML. Do not forge
          // the existing human comparison/image-rights approvals, even in auto_publish mode.
          if (item.processingMode === 'copy' && !isTrustedCopy(item)) {
            await jobState('review', 'Копия подготовлена. HTML-превью не подтверждает полноту текста/альбома: сравните оригинал, проверьте фото и утвердите вручную.'); continue
          }
          if ((!item.generatedText && policy.attempts >= 2) || ((item.socialPostId || item.enSocialPostId) && policy.status !== 'send_retry')) { await jobState('review', 'Проверьте материал и связанный Social перед продолжением.'); continue }
          const day = now.toISOString().slice(0, 10)
          if (state.aiDay !== day) { state.aiDay = day; state.aiUsed = 0 }
          if (item.processingMode !== 'copy' && !item.generatedText) {
            if (Number(state.aiUsed ?? 0) >= source.automation!.dailyLimit) { await save('ai_limit', 'Достигнут суточный бюджет AI-попыток.'); continue }
            state.aiUsed = Number(state.aiUsed ?? 0) + 1; policy.attempts = Number(policy.attempts) + 1
            await jobState('processing') // durable budget/claim BEFORE paid calls
            try { item = await (deps.prepare ?? prepareAutomationItem)(pool, item) }
            catch (e) { if (e instanceof AutomationClaimConflict) { await jobState('review', e.message); continue }; throw e }
          }
          if (item.sourceLanguage) await pool.query(`UPDATE content_factory_items SET ${item.sourceLanguage}_account_id = $1 WHERE id = $2 AND project_id = $3 AND ${item.sourceLanguage}_approved_at IS NULL`, [policy.accountId, item.id, item.projectId])
          if (policy.mode !== 'auto_publish' || (item.processingMode === 'copy' ? !isTrustedCopy(item) : needsAutomationEditor(item))) {
            await jobState('review', 'Материал подготовлен; требуется ручное согласование и проверка существенных утверждений.'); continue
          }
          const sendDay = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
          if (state.sendDay !== sendDay) { state.sendDay = sendDay; state.sendUsed = 0 }
          const delivered = await pool.query(`SELECT COUNT(DISTINCT p.id)::int AS count FROM social_publications p
            JOIN content_factory_items i ON i.project_id = p.project_id AND (p.social_post_id = i.social_post_id OR p.social_post_id = i.en_social_post_id)
            WHERE i.project_id = $1 AND i.source_id = $2 AND p.platform = 'telegram' AND p.status = 'published'
              AND p.published_at >= $3::date::timestamp AT TIME ZONE 'UTC'
              AND p.published_at < ($3::date + 1)::timestamp AT TIME ZONE 'UTC'`, [item.projectId, source.id, sendDay])
          state.sendUsed = Math.max(Number(state.sendUsed ?? 0), Number(delivered.rows[0]?.count ?? 0))
          if (Number(state.sendUsed ?? 0) >= source.automation!.dailyLimit) { await jobState(policy.status === 'send_retry' ? 'send_retry' : 'pending'); await save('daily_limit', 'Достигнут суточный лимит автоматических отправок.'); continue }
          if (policy.status !== 'send_retry') item = await (deps.approve ?? (item.processingMode === 'copy' ? approveMonitorCopy : approveAutomationItem))(pool, source, item)
          policy.sendAttempts = Number(policy.sendAttempts ?? 0) + 1
          state.sendUsed = Number(state.sendUsed ?? 0) + 1
          await jobState('publishing') // fail closed on a crash/unknown outcome; never resend blindly
          const published = await deps.publish(row.project_slug, item.id, item.sourceLanguage!)
          if ('error' in published) {
            const pub = await pool.query(`SELECT status FROM social_publications WHERE project_id = $1 AND platform = 'telegram'
              AND social_post_id IN (SELECT social_post_id FROM content_factory_items WHERE id = $2 AND project_id = $1
                UNION SELECT en_social_post_id FROM content_factory_items WHERE id = $2 AND project_id = $1)`, [item.projectId, item.id])
            const unknown = pub.rows.some((p) => p.status === 'publishing')
            const temporary = !unknown && pub.rows.length === 1 && pub.rows[0].status === 'failed'
              && /too many requests|retry after|request failed \(429\)|request failed \(5[0-9]{2}\)/i.test(published.error)
            if (temporary && policy.sendAttempts < 2) { await jobState('send_retry', 'Telegram явно отклонил запрос временно; один повтор через 10 минут через ту же публикацию Social.'); continue }
            state.paused = true
            await jobState(unknown ? 'uncertain' : 'review', unknown ? 'Отправка не подтверждена. Проверьте Telegram; повтор запрещён.' : 'Ошибка Social/Telegram. Проверьте результат вручную; автоматизация остановлена.')
            continue
          }
          state.failures = 0; await jobState('published')
        }
      } catch {
        state.failures = Number(state.failures ?? 0) + 1
        state.paused = Number(state.failures) >= 3
        // The result of a send is never downgraded to a retryable generation error.
        await save(state.paused ? 'paused' : 'error', 'Автоматическая операция не завершена. Проверьте материал; повторные расходы ограничены.')
        await pool.query(`UPDATE content_factory_items SET automation = jsonb_set(automation, '{status}', '"failed"'::jsonb), error = 'Ошибка автоматической подготовки', status = 'failed'
          WHERE project_id = $1 AND source_id = $2 AND automation->>'revision' = $3 AND automation->>'status' = 'processing' AND generated_text = ''
          AND social_post_id IS NULL AND en_social_post_id IS NULL`, [source.projectId, source.id, source.automationRevision])
      }
    } finally {
      try { if (held) await lock.query('SELECT pg_advisory_unlock(78216, $1)', [row.project_id]) }
      finally { lock.release() }
    }
  }
  return results
}
