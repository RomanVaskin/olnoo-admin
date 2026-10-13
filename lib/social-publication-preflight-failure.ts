import type { Pool } from 'pg'

// No `@/` imports — only the `pg` package's own `Pool` type — so this is directly testable under
// `node --test` against a real (or gracefully-skipped) Postgres, the same reasoning as
// lib/social-scheduler-lock.ts.

/**
 * Persists a pre-flight publish failure — a problem detected BEFORE any call to the platform's own
 * API (no account configured, no content, a missing token, an undecryptable credential, …) — onto
 * the social_publications row as `status = 'failed'` with the given message, the same terminal
 * state a platform API failure already writes.
 *
 * Root cause this fixes: every publisher (lib/social-telegram.ts, lib/social-vk.ts,
 * lib/social-instagram.ts, lib/social-threads.ts) already writes `status = 'failed'` when the
 * platform's own API call fails or throws — but a pre-flight problem detected before that call was
 * simply returned as `{ error, status }` to the caller, with NO write to the row at all. The row
 * was left in whatever non-terminal status it already had (`draft`/`ready`), so
 * lib/social-scheduler.ts's own candidate query (`WHERE pub.status <> 'published'`) kept matching
 * it, and the scheduler re-attempted the exact same doomed-to-fail call — no account configured
 * isn't going to resolve itself between one sweep and the next — every single minute, forever,
 * until a human noticed and fixed it by hand. Every publisher now calls this at each pre-flight
 * branch before returning its `{ error, status }`, so the row reaches a terminal, scheduler-
 * excluded state the same way an actual API failure already did.
 *
 * Scoped by `id` AND `projectId` like every other write in this module — a no-op (0 rows affected)
 * if the row doesn't belong to this project, which can't happen in practice here since callers
 * only ever call this after already having read/confirmed the row (or resolved the project the row
 * must belong to), but the scoping is kept anyway for the same defense-in-depth every other
 * project-scoped query in this app already has.
 *
 * This is a side effect alongside each call site's own `{ error, status }` return — never a
 * replacement for it. The individual "Publish to X" API route and the UI both depend on that exact
 * shape/status code reaching the caller unchanged.
 */
export async function recordPublicationPreflightFailure(
  pool: Pool,
  id: string,
  projectId: number,
  message: string,
): Promise<void> {
  await pool.query(
    `UPDATE social_publications SET status = 'failed', error = $1, updated_at = now() WHERE id = $2 AND project_id = $3`,
    [message, id, projectId],
  )
}
