// The atomic "find existing lead, else create one" behind Telegram Business intake (Patch D),
// kept free of `@/` imports so it can be tested against a real Postgres (see
// telegram-business-lead.test.ts) — same pattern as lib/lead-insert.ts and lib/crm-observer.ts:
// the caller (lib/telegram-business.ts, wired from the route) passes the pool in.
//
// One advisory-lock transaction per (projectId, contact) serializes concurrent/redelivered first
// messages from the same Telegram user, so a burst (or Telegram's own at-least-once redelivery)
// can never create two leads for the same contact. `createLead` runs the caller's own insert
// inside that same transaction/lock — production wires it to createLeadRecord, so Patch C's owner
// notification still fires exactly once per genuinely new lead.

import type { Pool, PoolClient } from 'pg'

export type TelegramLeadResult = { created: boolean; leadId: string }

export async function findOrCreateTelegramLead(
  pool: Pool,
  projectId: number,
  contact: string,
  createLead: (client: PoolClient) => Promise<string>,
): Promise<TelegramLeadResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`telegram-lead:${projectId}:${contact}`])
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM leads WHERE project_id = $1 AND contact = $2 ORDER BY created_at DESC LIMIT 1',
      [projectId, contact],
    )
    if (rows[0]) {
      await client.query('COMMIT')
      return { created: false, leadId: rows[0].id }
    }
    const leadId = await createLead(client)
    await client.query('COMMIT')
    return { created: true, leadId }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
