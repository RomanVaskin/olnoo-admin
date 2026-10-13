import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { withSchedulerLock, SCHEDULER_LOCK_KEY } from './social-scheduler-lock.ts'

// DB integration (skipped without a reachable Postgres) — same convention as
// lib/crm-observer.test.ts's own "DB integration" section: a locally created Pool, gracefully
// skipped (not failed) when Postgres isn't reachable in this environment.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(t: TestContext, fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT 1')
  } catch (err) {
    t.skip(`No reachable Postgres at DATABASE_URL — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  try {
    await fn(pool)
  } finally {
    await pool.end()
  }
}

test('withSchedulerLock: runs fn and reports not skipped when the lock is free', async (t) => {
  await withDb(t, async (pool) => {
    const outcome = await withSchedulerLock(pool, async () => 'did the work')
    assert.deepEqual(outcome, { skipped: false, result: 'did the work' })
  })
})

test('withSchedulerLock: a second overlapping call sees the lock held and is skipped without running fn', async (t) => {
  await withDb(t, async (pool) => {
    // Hold the lock on a separate, dedicated connection — simulating a scheduler run already in
    // progress — then confirm a second call observes it as held.
    const holder = await pool.connect()
    try {
      const { rows } = await holder.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        SCHEDULER_LOCK_KEY,
      ])
      assert.equal(rows[0]?.locked, true, 'test setup: the holder connection must acquire the lock first')

      let ran = false
      const outcome = await withSchedulerLock(pool, async () => {
        ran = true
      })
      assert.deepEqual(outcome, { skipped: true })
      assert.equal(ran, false, 'fn must never run while the lock is held elsewhere')
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY])
      holder.release()
    }
  })
})

// The actual regression this guards against: the lock must be acquired, held, and released on the
// SAME connection throughout — not on a different one handed back by the pool for each query. We
// can't directly observe "which connection" from here, but we CAN observe the one behavior that
// only holds if that's true: once withSchedulerLock returns, the lock is actually free again — a
// fresh acquisition attempt immediately succeeds. If acquire/release had used different pooled
// connections (the bug this replaces), the unlock could easily be a no-op on the wrong session,
// leaving the lock still held after this call returns.
test('withSchedulerLock: the lock is fully released by the time the call returns — a fresh acquisition immediately succeeds', async (t) => {
  await withDb(t, async (pool) => {
    const outcome = await withSchedulerLock(pool, async () => 'done')
    assert.deepEqual(outcome, { skipped: false, result: 'done' })

    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        SCHEDULER_LOCK_KEY,
      ])
      assert.equal(rows[0]?.locked, true, 'the lock must be free immediately after withSchedulerLock returns')
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY])
      client.release()
    }
  })
})

test('withSchedulerLock: the lock is released even when fn throws', async (t) => {
  await withDb(t, async (pool) => {
    await assert.rejects(
      withSchedulerLock(pool, async () => {
        throw new Error('boom')
      }),
      /boom/,
    )

    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        SCHEDULER_LOCK_KEY,
      ])
      assert.equal(rows[0]?.locked, true, 'the lock must still be released after fn throws')
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY])
      client.release()
    }
  })
})
