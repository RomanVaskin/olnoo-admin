import { timingSafeEqual } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { findOrCreateTelegramLead } from './telegram-business-lead.ts'
import {
  classifyTelegramBusinessUpdate,
  telegramContactKey,
  telegramLeadMessage,
  type TelegramBusinessUpdateDecision,
} from './telegram-business-update.ts'

// Server-side only. Telegram Business intake: accepts and acknowledges a client's message to a
// connected business account. Patch A disabled lead creation for every connection. Patch D
// (this revision) re-enables it, but ONLY for the one connection configured as DriveSet's
// (TELEGRAM_BUSINESS_DRIVESET_CONNECTION_ID) — every other business_connection_id still ends
// `ignored`, same as Patch A. This module never calls sendMessage or any other method that
// writes to a chat; the owner's Telegram notification for a created lead is sent entirely by
// createLeadRecord (Patch C) — nothing here duplicates that.
//
// Kept free of `@/` imports so it runs directly under `node --test` (see
// telegram-business.test.ts) — the real DB pool, resolveProjectId and createLeadRecord are
// injected by the route (app/api/telegram/business-webhook/route.ts) via TelegramBusinessDeps,
// which is the only place that imports `@/lib/db` and `@/lib/crm`.

export type TelegramBusinessConfig = {
  token: string
  secret: string
  ownerUserId: string
  project: string
  /** The one business_connection_id that may create a lead (DriveSet's). Empty = none configured
   * → every incoming message stays ignored, same as Patch A (fail closed, never fail open). */
  driveSetConnectionId: string
}

export function telegramBusinessConfig(): TelegramBusinessConfig | null {
  const token = process.env.TELEGRAM_BUSINESS_BOT_TOKEN?.trim()
  const secret = process.env.TELEGRAM_BUSINESS_WEBHOOK_SECRET?.trim()
  const ownerUserId = process.env.TELEGRAM_BUSINESS_OWNER_USER_ID?.trim()
  const project = process.env.TELEGRAM_BUSINESS_PROJECT?.trim()
  if (!token || !secret || !ownerUserId || !/^\d+$/.test(ownerUserId) || !project) return null
  const driveSetConnectionId = process.env.TELEGRAM_BUSINESS_DRIVESET_CONNECTION_ID?.trim() ?? ''
  return { token, secret, ownerUserId, project, driveSetConnectionId }
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

/** DB/CRM dependencies, injected by the caller so this module stays `@/`-free (see top of file). */
export type TelegramBusinessDeps = {
  pool: Pool
  resolveProjectId: (slug: string) => Promise<number | null>
  /** Inserts the lead inside the caller's transaction/lock; returns the new lead's id. Production
   * wires this to createLeadRecord (Patch C), so the owner's Telegram notification still fires. */
  createLead: (
    input: { project: string; name: string; contact: string; message: string; channel: string; source: string },
    client: PoolClient,
  ) => Promise<string>
}

/**
 * Handles one webhook update. Throws only on a transient failure (DB) on the DriveSet
 * lead-creation path, so the route can answer 500 and Telegram redelivers safely — redelivery
 * never creates a second lead, see findOrCreateTelegramLead.
 */
export async function handleTelegramBusinessUpdate(
  update: unknown,
  config: TelegramBusinessConfig,
  deps: TelegramBusinessDeps,
): Promise<TelegramBusinessOutcome> {
  const decision = classifyTelegramBusinessUpdate(update, config.ownerUserId)

  if (decision.kind === 'ignore') return { action: 'ignored', reason: decision.reason }

  if (decision.kind === 'connection') {
    if (decision.ownerUserId !== config.ownerUserId) {
      // Anyone can attach a public bot to their own business account; such connections are inert.
      console.warn(`[tg-business] connection ${decision.connectionId} from an unexpected account is ignored`)
      return { action: 'ignored', reason: 'connection from an unexpected account' }
    }
    console.info(`[tg-business] owner connection ${decision.connectionId} is ${decision.enabled ? 'enabled' : 'disabled'}`)
    return { action: 'connection', enabled: decision.enabled }
  }

  // decision.kind === 'incoming'. Only the configured DriveSet connection may create a lead —
  // every other connection (including no connection configured at all) keeps Patch A's disabled
  // behavior, unchanged in wording so existing monitoring/tests built on it still match.
  if (!config.driveSetConnectionId || decision.connectionId !== config.driveSetConnectionId) {
    return { action: 'ignored', reason: 'incoming business messages no longer create leads (disabled)' }
  }
  return handleDriveSetMessage(decision, config.project, deps)
}

/**
 * One open lead per Telegram user per project (DriveSet only, by construction — only called once
 * the connection has already been matched). Any existing lead for this contact — in any status —
 * blocks a new one: no reopen-after-close nuance in this minimal pass.
 */
async function handleDriveSetMessage(
  incoming: Extract<TelegramBusinessUpdateDecision, { kind: 'incoming' }>,
  projectSlug: string,
  deps: TelegramBusinessDeps,
): Promise<TelegramBusinessOutcome> {
  const projectId = await deps.resolveProjectId(projectSlug)
  if (!projectId) throw new Error(`TELEGRAM_BUSINESS_PROJECT "${projectSlug}" is not a known project slug`)

  const contact = telegramContactKey(incoming.telegramUserId)
  const result = await findOrCreateTelegramLead(deps.pool, projectId, contact, (client) =>
    deps.createLead(
      {
        project: projectSlug,
        name: incoming.displayName,
        contact,
        message: telegramLeadMessage(incoming),
        channel: 'Telegram',
        // No ad attribution travels with a Telegram message: never claim Ads/Yandex Direct here.
        source: 'Direct',
      },
      client,
    ),
  )
  return result.created ? { action: 'lead_created', leadId: result.leadId } : { action: 'lead_exists', leadId: result.leadId }
}
