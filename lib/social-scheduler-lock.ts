import type { Pool } from 'pg'

// No `@/` imports — only the `pg` package's own `Pool` type — so this is directly testable under
// `node --test` against a real (or gracefully-skipped) Postgres, the same way lib/crm-observer.ts
// is kept import-light for the same reason.

// A single, fixed Postgres advisory lock key for the whole scheduler sweep (not per-post, not
// per-project — only one sweep needs to run at a time on this one server). Arbitrary but must stay
// stable across deploys/restarts (advisory lock keys are just int8 values, not tied to any schema).
export const SCHEDULER_LOCK_KEY = 727142001

/**
 * Runs `fn` while holding `SCHEDULER_LOCK_KEY` as a Postgres advisory lock, acquired, held, and
 * released through ONE connection checked out from `pool` for the whole call — never through
 * `pool.query()` directly.
 *
 * Root cause this fixes: `pg_advisory_lock`/`pg_advisory_unlock` are tied to the specific Postgres
 * backend/session that calls them, not to the logical connection pool. Calling
 * `pool.query('SELECT pg_try_advisory_lock(...)')` and, later, `pool.query('SELECT
 * pg_advisory_unlock(...)')` each independently checks out WHATEVER connection the pool happens to
 * hand back at that moment — not necessarily the same one. If they land on different connections,
 * the "unlock" is a silent no-op (that session never held the lock), while the lock taken on the
 * other, now-returned-to-the-pool connection stays held until that connection itself closes — in
 * the worst case, not until the process restarts — defeating the one-sweep-at-a-time guarantee
 * this lock exists for (a second overlapping sweep would see the lock still held by the first long
 * after it actually finished, and simply stop running forever). `pool.connect()` checks out one
 * physical connection that this function alone uses for both calls, start to finish, and always
 * releases it back to the pool (`client.release()`) no matter how `fn` finishes.
 *
 * Returns `{ skipped: true }` without calling `fn` at all if another sweep already holds the lock
 * (pg_try_advisory_lock doesn't block — it reports false immediately rather than queuing up).
 */
export async function withSchedulerLock<T>(
  pool: Pool,
  fn: () => Promise<T>,
): Promise<{ skipped: true } | { skipped: false; result: T }> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      SCHEDULER_LOCK_KEY,
    ])
    if (!rows[0]?.locked) {
      return { skipped: true }
    }
    try {
      const result = await fn()
      return { skipped: false, result }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}
