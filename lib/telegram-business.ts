import { timingSafeEqual } from 'node:crypto'
import { pool } from '@/lib/db'
import { createLeadRecord, resolveProjectId } from '@/lib/crm'
import {
  classifyTelegramBusinessUpdate,
  telegramContactKey,
  telegramLeadMessage,
  type TelegramBusinessUpdateDecision,
} from '@/lib/telegram-business-update'

// Server-side only. Telegram Business intake: a client writes to the connected business account
// (e.g. DriveSet) → one CRM lead. This module never calls sendMessage or any other method that
// writes to a chat — the only Telegram Bot API call is the read-only getBusinessConnection.
// The bot is connected without reply rights; managers answer clients in Telegram themselves.

// Same non-secret override as lib/social-telegram.ts: lets a non-production environment point at
// a mock Bot API. The token is a different bot from TELEGRAM_BOT_TOKEN (Social publishing).
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org'
const CONNECTION_CACHE_TTL_MS = 10 * 60 * 1000

type TelegramBusinessConfig = { token: string; secret: string; ownerUserId: string; project: string }

export function telegramBusinessConfig(): TelegramBusinessConfig | null {
  const token = process.env.TELEGRAM_BUSINESS_BOT_TOKEN?.trim()
  const secret = process.env.TELEGRAM_BUSINESS_WEBHOOK_SECRET?.trim()
  const ownerUserId = process.env.TELEGRAM_BUSINESS_OWNER_USER_ID?.trim()
  const project = process.env.TELEGRAM_BUSINESS_PROJECT?.trim()
  if (!token || !secret || !ownerUserId || !/^\d+$/.test(ownerUserId) || !project) return null
  return { token, secret, ownerUserId, project }
}

/** Constant-time check of Telegram's X-Telegram-Bot-Api-Secret-Token header. */
export function isValidWebhookSecret(provided: string | null, expected: string): boolean {
  const a = Buffer.from(provided ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type TelegramBusinessOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'connection'; enabled: boolean }
  | { action: 'lead_created'; leadId: string }
  | { action: 'lead_exists'; leadId: string }

/**
 * Handles one webhook update. Throws only on transient failures (DB, Telegram API) so the route
 * can answer 500 and Telegram redelivers; redelivery is safe because lead creation is deduped.
 */
export async function handleTelegramBusinessUpdate(update: unknown, config: TelegramBusinessConfig): Promise<TelegramBusinessOutcome> {
  const decision = classifyTelegramBusinessUpdate(update, config.ownerUserId)

  if (decision.kind === 'ignore') return { action: 'ignored', reason: decision.reason }

  if (decision.kind === 'connection') {
    connectionCache.delete(decision.connectionId)
    if (decision.ownerUserId !== config.ownerUserId) {
      // Anyone can attach a public bot to their own business account; such connections are inert.
      console.warn(`[tg-business] connection ${decision.connectionId} from an unexpected account is ignored`)
      return { action: 'ignored', reason: 'connection from an unexpected account' }
    }
    console.info(`[tg-business] owner connection ${decision.connectionId} is ${decision.enabled ? 'enabled' : 'disabled'}`)
    return { action: 'connection', enabled: decision.enabled }
  }

  if (!(await isOwnerConnection(decision.connectionId, config))) {
    return { action: 'ignored', reason: 'message from a connection that is not the configured owner' }
  }
  return findOrCreateTelegramLead(decision, config.project)
}

/**
 * One open lead per Telegram user per project. The advisory lock serialises concurrent first
 * messages from the same user, so a burst of messages (or a redelivered update) cannot insert two
 * leads. A lead in Won/Lost is closed: the next message after that is a new enquiry → new lead.
 */
async function findOrCreateTelegramLead(
  incoming: Extract<TelegramBusinessUpdateDecision, { kind: 'incoming' }>,
  projectSlug: string,
): Promise<TelegramBusinessOutcome> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) throw new Error(`TELEGRAM_BUSINESS_PROJECT "${projectSlug}" is not a known project slug`)

  const contact = telegramContactKey(incoming.telegramUserId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`telegram-lead:${projectId}:${contact}`])
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM leads WHERE project_id = $1 AND contact = $2 AND status NOT IN ('Won', 'Lost')
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, contact],
    )
    if (rows[0]) {
      await client.query('COMMIT')
      return { action: 'lead_exists', leadId: rows[0].id }
    }

    const result = await createLeadRecord(
      {
        project: projectSlug,
        name: incoming.displayName,
        contact,
        message: telegramLeadMessage(incoming),
        // No ad attribution travels with a Telegram message: never claim Ads/Yandex Direct here.
        source: 'Direct',
      },
      client,
    )
    if ('error' in result) throw new Error(`lead insert rejected: ${result.error}`)
    await client.query('COMMIT')
    return { action: 'lead_created', leadId: String(result.row.id) }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const connectionCache = new Map<string, { owner: boolean; expires: number }>()

/** Read-only getBusinessConnection: the connection must belong to the configured owner and be enabled. */
async function isOwnerConnection(connectionId: string, config: TelegramBusinessConfig): Promise<boolean> {
  const cached = connectionCache.get(connectionId)
  if (cached && cached.expires > Date.now()) return cached.owner

  const res = await fetch(`${TELEGRAM_API_BASE}/bot${config.token}/getBusinessConnection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ business_connection_id: connectionId }),
    signal: AbortSignal.timeout(7_000),
  })
  const data = await res.json().catch(() => null)
  if (res.status === 400 && data?.ok === false) {
    // Unknown/revoked connection id: a permanent answer, not worth a redelivery.
    connectionCache.set(connectionId, { owner: false, expires: Date.now() + CONNECTION_CACHE_TTL_MS })
    return false
  }
  if (!res.ok || data?.ok !== true) throw new Error(`getBusinessConnection failed (${res.status})`)

  const owner = String(data.result?.user?.id ?? '') === config.ownerUserId && data.result?.is_enabled === true
  connectionCache.set(connectionId, { owner, expires: Date.now() + CONNECTION_CACHE_TTL_MS })
  return owner
}
