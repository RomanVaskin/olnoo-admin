// Server-side only. TELEGRAM_BOT_TOKEN must never be sent to the browser — it is read here and
// only here, inside a function called exclusively from createLeadRecord (lib/crm.ts), itself only
// ever called from server route handlers.
//
// Mirrors lib/social-telegram.ts's Telegram Bot API call: same token/base-URL env handling, same
// never-throw-outward error handling. Kept free of `@/` aliased imports so it runs under plain
// `node --test` without a DB or network. `send` on notifyLeadCreated is injectable for tests.

import type { Pool, PoolClient } from 'pg'

const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'
const ADMIN_BASE_URL = process.env.PUBLIC_SITE_URL || 'https://admin.olnoo.com'

export type LeadNotifyRow = {
  name?: string | null
  service?: string | null
  source?: string | null
  /** How the lead got in touch (Form/Quiz/Telegram/...) — distinct from `source`. */
  channel?: string | null
  phone?: string | null
  email?: string | null
  contact?: string | null
}

export type ProjectInfo = { name: string; slug: string }

export async function resolveProjectInfo(db: Pick<Pool | PoolClient, 'query'>, projectId: number): Promise<ProjectInfo | null> {
  const { rows } = await db.query<{ name: string; slug: string }>('SELECT name, slug FROM projects WHERE id = $1', [projectId])
  return rows[0] ?? null
}

/** Minimal message: only fields that actually have a value are printed — never an empty line. */
export function formatLeadNotification(row: LeadNotifyRow, project: ProjectInfo): string {
  const contact = (row.phone?.trim() || row.email?.trim() || row.contact?.trim() || '')
  const lines = [`Новый лид — ${project.name}`, '']
  const field = (label: string, value: string | null | undefined) => {
    const v = (value ?? '').trim()
    if (v) lines.push(`${label}: ${v}`)
  }
  field('Имя', row.name)
  field('Услуга', row.service)
  field('Источник', row.source)
  field('Канал', row.channel)
  field('Контакт', contact)
  lines.push('', 'Открыть в CRM:', `${ADMIN_BASE_URL}/en?screen=crm-leads&project=${project.slug}`)
  return lines.join('\n')
}

/**
 * Whether createLeadRecord should fire the owner's Telegram notification for an insert result:
 * only after a genuinely new row — never for an idempotent `lead_tracking_id` replay. Pulled out
 * as a pure function (same pattern as lib/leads-project-filter.ts) so this exact gating is
 * exercised directly in tests, without a database.
 */
export function shouldNotifyLeadCreation(insertResult: { replay?: boolean }): boolean {
  return !insertResult.replay
}

export type SendResult = { ok: true } | { error: string }
export type SendFn = (chatId: string, text: string) => Promise<SendResult>

async function sendTelegramMessage(chatId: string, text: string): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return { error: 'TELEGRAM_BOT_TOKEN is not configured' }
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.ok) {
      return { error: (data && typeof data.description === 'string' && data.description) || `Telegram API request failed (${res.status})` }
    }
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Notifies the owner on Telegram that a new lead was created. Never throws and never affects the
 * lead it follows: a missing CRM_NOTIFY_TELEGRAM_CHAT_ID (or TELEGRAM_BOT_TOKEN) skips the call and
 * logs once; a Telegram API error (HTTP or network) is logged and swallowed. `send` defaults to the
 * real Bot API call and is injectable so tests never hit the real Telegram API.
 */
export async function notifyLeadCreated(row: LeadNotifyRow, project: ProjectInfo, send: SendFn = sendTelegramMessage): Promise<void> {
  const chatId = process.env.CRM_NOTIFY_TELEGRAM_CHAT_ID
  if (!chatId) {
    console.warn('[lead-notify] CRM_NOTIFY_TELEGRAM_CHAT_ID is not configured — skipping lead notification')
    return
  }
  try {
    const result = await send(chatId, formatLeadNotification(row, project))
    if ('error' in result) {
      console.error('[lead-notify] failed to send Telegram notification:', result.error)
    }
  } catch (err) {
    console.error('[lead-notify] failed to send Telegram notification:', err instanceof Error ? err.message : String(err))
  }
}
