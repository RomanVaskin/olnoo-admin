// Server-side primitive for the manual traffic-class override (Test Traffic v1, step A). No endpoint and no UI use it yet.
// Needs migration 0016. `db` may be the pool or a transaction client. No `@/` imports.

import type { Pool, PoolClient } from 'pg'
import type { TrafficOverride } from './traffic-class.ts'

/**
 * Sets (REAL | TEST) or clears (null) the manual override of one lead. The override wins over the automatic class;
 * clearing it restores the automatic class. Returns false if there is no such lead. The timestamp is set together with
 * the override and cleared with it. (No audit log in v1: only the current override and when it was set are kept.)
 */
export async function setTrafficClassOverride(db: Pick<Pool | PoolClient, 'query'>, leadId: string, override: TrafficOverride | null): Promise<boolean> {
  if (override !== null && override !== 'REAL' && override !== 'TEST') throw new Error('override must be REAL, TEST or null')
  const { rowCount } = await db.query(
    `UPDATE leads
        SET traffic_class_override = $2::text,
            traffic_class_override_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END
      WHERE id = $1`,
    [leadId, override],
  )
  return (rowCount ?? 0) > 0
}
