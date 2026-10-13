import type { Pool } from 'pg'

// No `@/` imports — only the `pg` package's own `Pool` type — so this is directly testable under
// `node --test` against a real (or gracefully-skipped) Postgres, the same reasoning as
// lib/social-scheduler-lock.ts and lib/social-publication-preflight-failure.ts.

export type PublicationClaim =
  | { claimed: true; row: Record<string, unknown> }
  | { claimed: false; currentStatus: string | null }

/**
 * Atomically transitions a social_publications row into `'publishing'` — the one moment right
 * before the actual, non-idempotent call to the platform's own API (Telegram's sendMessage, VK's
 * wall.post, Instagram's media_publish, Threads' threads_publish). Each publisher calls this
 * immediately before that specific call, never earlier (every check before it — content, account,
 * token, ownership — is a local/idempotent read, not racy) and never through a separate
 * read-then-write, which is NOT atomic under concurrency: two requests (the "Publish selected
 * channels" button and the scheduler, say, firing within the same second) could both read
 * status='ready' and both decide to proceed before either writes anything.
 *
 * A single `UPDATE ... WHERE status NOT IN ('publishing', 'published') ... RETURNING *` is atomic
 * by construction: Postgres takes a row lock for the UPDATE, so under two concurrent calls for the
 * same row, the second transaction's UPDATE blocks on the first's lock, then — once the first
 * commits — re-evaluates its own WHERE clause against the now-current (first caller's) row. Since
 * the first caller already flipped status to `'publishing'`, the second's WHERE clause excludes
 * the row and it affects zero rows. So AT MOST ONE caller's claim ever returns `claimed: true`,
 * and every loser gets `claimed: false` and MUST NOT call the platform API.
 *
 * `claimed: false` covers three situations the claim itself can't (and doesn't need to)
 * distinguish precisely — none of them may proceed regardless of which it is: the row is already
 * `'published'`, a genuinely concurrent attempt is mid-flight (`'publishing'`), or it's a STUCK
 * `'publishing'` row left over from a previous attempt that never reached its own final write (a
 * timeout, a dropped connection, or the process dying mid-request). That last case is exactly why
 * the scheduler must never auto-retry a `'publishing'` row: this same WHERE clause refuses it
 * forever, on every future call, automatic or manual, until a human manually resolves the row
 * (confirms the real outcome on the platform itself, then PATCHes the row directly to `'failed'`
 * or `'published'`) — there is no automatic unstick mechanism, by design.
 */
export async function claimPublicationForSending(pool: Pool, id: string, projectId: number): Promise<PublicationClaim> {
  const { rows } = await pool.query(
    `UPDATE social_publications SET status = 'publishing', updated_at = now()
     WHERE id = $1 AND project_id = $2 AND status NOT IN ('publishing', 'published')
     RETURNING *`,
    [id, projectId],
  )
  if (rows[0]) return { claimed: true, row: rows[0] }

  const { rows: currentRows } = await pool.query<{ status: string }>(
    'SELECT status FROM social_publications WHERE id = $1 AND project_id = $2',
    [id, projectId],
  )
  return { claimed: false, currentStatus: currentRows[0]?.status ?? null }
}

/** The error/status pair every publisher returns when `claimPublicationForSending` reports
 * `claimed: false` — pulled out so the message is worded identically everywhere and the 409 status
 * (already used for the pre-existing "already published" guard) keeps meaning the same thing:
 * "don't retry this from here, something else already has it or already finished it." */
export function publicationClaimConflictResult(currentStatus: string | null): { error: string; status: 409 } {
  if (currentStatus === 'published') {
    return { error: 'this publication is already published', status: 409 }
  }
  return {
    error:
      'this publication is already being published, or a previous attempt never finished — check the platform directly before retrying',
    status: 409,
  }
}
