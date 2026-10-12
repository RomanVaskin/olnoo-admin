import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'
import { verifyTelegramChannelAccess, normalizeTelegramChatIdentifier } from '@/lib/social-telegram-verify'

// Connects and re-verifies a project's own Telegram channel (Social → Accounts) against the
// existing shared bot — no per-project bot, no new secret: the bot token stays the single
// server-only TELEGRAM_BOT_TOKEN env var lib/social-telegram.ts already reads, same as every
// project. What's new is verifying, before relying on it, that the bot can actually post into the
// specific channel a project names (requirement 2), and that no two projects can end up pointed at
// the same channel by a configuration mistake (requirement 5's isolation, at connect time rather
// than only at publish time).

export type TelegramConnectionResult = { error: string; status: number } | { row: Record<string, unknown> }

const ACCOUNT_COLUMNS =
  'id, project_id, platform, name, username, public_url, status, active, notes, vk_group_id, connection_error, created_at, updated_at'

/**
 * The confirmed Telegram chat.id is what makes two different admin-typed identifiers ("@handle" vs
 * the numeric id copied from a forwarded message) resolvable to the SAME channel: getChat always
 * returns the channel's one real `username` (if it has a public one) regardless of which form was
 * queried with, so canonicalizing on that — falling back to the numeric `chat.id` only for a
 * private channel with no username — is what the cross-project duplicate check and the stored
 * `username` column both key on. A raw, un-canonicalized comparison of admin-typed text (the
 * previous version of this file) could miss that "@my_channel" and "-1001234567890" are the same
 * channel, or could be fooled by incidental text differences — neither is possible once both sides
 * of the comparison are this confirmed value.
 */
function canonicalChatIdentifier(identity: { chatId: string; username: string }): string {
  return identity.username ? normalizeTelegramChatIdentifier(identity.username) : identity.chatId
}

// Fixed namespace for the advisory lock below (pg_advisory_xact_lock takes two int4 keys) — chosen
// to not collide with lib/social-scheduler.ts's own single-int8 SCHEDULER_LOCK_KEY (727142001),
// which uses the one-argument form and so lives in a different key space anyway, but a distinct
// constant here keeps that unambiguous. The second key is a hash of the specific channel identifier
// being connected, so locking is per-channel, not a single global lock over all connect attempts.
const TELEGRAM_CONNECT_LOCK_NAMESPACE = 851100027

/**
 * Connects (new/replacement channel identifier) or re-checks (no identifier given — uses the
 * username already stored) a Telegram account's connection. Mirrors
 * lib/social-accounts-vk-connection.ts's two failure modes on purpose:
 *   - A new/replacement channel identifier that fails verification (bot not added, no posting
 *     rights, wrong chat type, channel not found) changes nothing in the database — the account's
 *     existing working connection, if any, is left exactly as it was.
 *   - A recheck of the already-connected channel failing means the bot has genuinely lost access
 *     (removed as admin, rights revoked, channel deleted) — that is real, current state, so
 *     `status`/`connection_error` ARE persisted (requirement 3: show a real connection status).
 *
 * Cross-project isolation guard: before persisting a successful connection, refuses (409) if
 * another project's Telegram account already holds the same confirmed chat.id (see
 * canonicalChatIdentifier above) with status='connected'. Without this, two projects could each
 * enter the same channel (by mistake, or by copying a config) and both would "successfully"
 * publish there — the shared-bot design makes that technically possible, so it has to be refused
 * here rather than relying on the admin never making that mistake.
 *
 * Concurrency: the conflict check and the write that follows it are a classic check-then-act — two
 * simultaneous connect requests for the SAME channel (different accounts/projects) could otherwise
 * both pass the check before either commits. The Telegram API call itself (verifyTelegramChannelAccess)
 * runs first, outside any lock, since it's the slow part and doesn't need exclusivity; only the
 * conflict check + write are wrapped in one transaction holding a Postgres advisory lock keyed by
 * the confirmed channel identifier (pg_advisory_xact_lock, auto-released at commit/rollback — same
 * mechanism lib/social-scheduler.ts already uses for its own overlap protection, just transaction-
 * scoped and per-channel instead of session-scoped and global). A second request for the same
 * channel blocks until the first transaction commits, then correctly sees the now-committed row
 * and is refused — no unique constraint or migration needed for this.
 */
export async function connectOrRecheckTelegramAccount(
  id: string,
  projectSlug: string | null,
  newIdentifier: string | null,
): Promise<TelegramConnectionResult> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const { rows } = await pool.query<{ platform: string; username: string; public_url: string }>(
    'SELECT platform, username, public_url FROM social_accounts WHERE id = $1 AND project_id = $2',
    [id, projectId],
  )
  const account = rows[0]
  if (!account) return { error: 'not found', status: 404 }
  if (account.platform !== 'telegram') return { error: 'this is not a Telegram account', status: 400 }

  const identifierToVerify = newIdentifier?.trim() || account.username?.trim() || ''
  const isRecheckOfStoredIdentifier = !newIdentifier?.trim()
  if (!identifierToVerify) {
    return { error: 'a channel username or chat id is required to connect', status: 400 }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return { error: 'TELEGRAM_BOT_TOKEN is not configured on the server', status: 500 }

  const verified = await verifyTelegramChannelAccess(token, identifierToVerify)

  if (!verified.ok) {
    if (isRecheckOfStoredIdentifier) {
      const { rows: updated } = await pool.query(
        `UPDATE social_accounts SET status = 'error', connection_error = $1, updated_at = now() WHERE id = $2 AND project_id = $3 RETURNING ${ACCOUNT_COLUMNS}`,
        [verified.error, id, projectId],
      )
      return { row: updated[0] }
    }
    return { error: verified.error, status: 502 }
  }

  const canonical = canonicalChatIdentifier(verified.identity)
  const nextPublicUrl = account.public_url?.trim() || (verified.identity.username ? `https://t.me/${verified.identity.username}` : '')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [TELEGRAM_CONNECT_LOCK_NAMESPACE, canonical.toLowerCase()])

    const { rows: conflicts } = await client.query<{ id: string; project_id: number }>(
      `SELECT id, project_id FROM social_accounts
       WHERE platform = 'telegram' AND id <> $1 AND status = 'connected' AND lower(username) = lower($2)`,
      [id, canonical],
    )
    if (conflicts.some((c) => c.project_id !== projectId)) {
      await client.query('ROLLBACK')
      return {
        error: 'This Telegram channel is already connected to another project — a channel can only be connected to one project at a time',
        status: 409,
      }
    }

    const { rows: updated } = await client.query(
      `UPDATE social_accounts
       SET username = $1, public_url = $2, status = 'connected', connection_error = '', updated_at = now()
       WHERE id = $3 AND project_id = $4
       RETURNING ${ACCOUNT_COLUMNS}`,
      [canonical, nextPublicUrl, id, projectId],
    )
    await client.query('COMMIT')
    return { row: updated[0] }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
