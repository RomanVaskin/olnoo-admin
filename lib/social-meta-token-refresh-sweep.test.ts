import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { encryptAccountSecret, decryptAccountSecret } from './social-account-crypto.ts'
import { refreshExpiringMetaTokens } from './social-meta-token-refresh-sweep.ts'
import { REFRESH_WINDOW_DAYS } from './social-meta-token-refresh-window.ts'

// DB integration (skipped without a reachable Postgres) — same convention as
// lib/social-publication-claim.test.ts. Network calls to Meta are scripted (same approach as
// lib/social-meta-token-refresh.test.ts) so this never makes a real outbound request.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

// SOCIAL_ACCOUNT_ENCRYPTION_KEY must be set for encryptAccountSecret/decryptAccountSecret to work
// at all (see lib/social-account-crypto.ts) — the test suite's own env must already provide one
// for lib/social-account-crypto.test.ts to pass; this file relies on the same env being present.

type AccountSpec = {
  platform: 'instagram' | 'threads'
  token: string
  expiresInDays: number | null // null = no expiry set at all (never selected)
}

async function withDb(
  t: TestContext,
  fn: (
    pool: Pool,
    ctx: {
      makeAccount: (projectId: number, spec: AccountSpec) => Promise<string>
      makeProject: () => Promise<number>
      readAccount: (id: string) => Promise<Record<string, unknown>>
    },
  ) => Promise<void>,
) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT instagram_access_token_encrypted FROM social_accounts LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the social_accounts Meta-credential columns — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }

  const clientIds: number[] = []
  const makeProject = async () => {
    const clientId = (
      await pool.query(`INSERT INTO clients (name) VALUES ('__test_meta_refresh_sweep__' || clock_timestamp()::text) RETURNING id`)
    ).rows[0].id as number
    clientIds.push(clientId)
    const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const projectId = (
      await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [
        clientId,
        'meta refresh sweep test',
        `${slug}.example`,
        slug,
      ])
    ).rows[0].id as number
    return projectId
  }

  const makeAccount = async (projectId: number, spec: AccountSpec) => {
    const id = randomUUID()
    const encrypted = encryptAccountSecret(spec.token)
    const expiresAt = spec.expiresInDays === null ? null : new Date(Date.now() + spec.expiresInDays * 24 * 60 * 60 * 1000)
    const tokenColumn = spec.platform === 'instagram' ? 'instagram_access_token_encrypted' : 'threads_access_token_encrypted'
    const idColumn = spec.platform === 'instagram' ? 'instagram_account_id' : 'threads_user_id'
    const expiresColumn = spec.platform === 'instagram' ? 'instagram_token_expires_at' : 'threads_token_expires_at'
    await pool.query(
      `INSERT INTO social_accounts (id, project_id, platform, name, username, status, ${tokenColumn}, ${idColumn}, ${expiresColumn})
       VALUES ($1, $2, $3, 'test account', 'tester', 'connected', $4, 'ext-id', $5)`,
      [id, projectId, spec.platform, encrypted, expiresAt ? expiresAt.toISOString() : null],
    )
    return id
  }

  const readAccount = async (id: string) => {
    const { rows } = await pool.query('SELECT * FROM social_accounts WHERE id = $1', [id])
    return rows[0]
  }

  try {
    await fn(pool, { makeAccount, makeProject, readAccount })
  } finally {
    for (const clientId of clientIds) {
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId]) // cascades to projects -> social_accounts
    }
    await pool.end()
  }
}

/** Scripted global fetch (same approach as lib/social-meta-token-refresh.test.ts). The handler may
 * itself be async — one test below deliberately performs a concurrent DB write from inside it, to
 * race with the sweep's own read-then-write. */
async function withFetch<T>(
  handler: (url: string) => Response | Error | Promise<Response | Error>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const out = await handler(String(url))
    if (out instanceof Error) throw out
    return out
  }) as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// --- Successful refresh ---

test('refreshExpiringMetaTokens: an expiring-soon Instagram token is refreshed and re-encrypted', async (t) => {
  await withDb(t, async (pool, { makeAccount, makeProject, readAccount }) => {
    const projectId = await makeProject()
    const id = await makeAccount(projectId, { platform: 'instagram', token: 'old-ig-token', expiresInDays: 3 })

    const results = await withFetch(
      () => jsonResponse({ access_token: 'new-ig-token', token_type: 'bearer', expires_in: 5184000 }),
      () => refreshExpiringMetaTokens(pool),
    )

    const mine = results.find((r) => r.id === id)
    assert.ok(mine, 'expected this account to be picked up')
    assert.equal(mine!.outcome, 'refreshed')

    const row = await readAccount(id)
    assert.equal(decryptAccountSecret(row.instagram_access_token_encrypted as string), 'new-ig-token')
    assert.equal(row.connection_error, '')
    assert.equal(row.status, 'connected')
    assert.ok(new Date(row.instagram_token_expires_at as string).getTime() > Date.now() + 50 * 24 * 60 * 60 * 1000)
  })
})

test('refreshExpiringMetaTokens: a Threads token outside the refresh window is left untouched', async (t) => {
  await withDb(t, async (pool, { makeAccount, makeProject, readAccount }) => {
    const projectId = await makeProject()
    const farId = await makeAccount(projectId, { platform: 'threads', token: 'far-token', expiresInDays: REFRESH_WINDOW_DAYS + 10 })

    const results = await withFetch(
      () => jsonResponse({ access_token: 'should-not-be-used', expires_in: 5184000 }),
      () => refreshExpiringMetaTokens(pool),
    )

    assert.ok(!results.some((r) => r.id === farId), 'a token far from expiry must not be touched at all')
    const row = await readAccount(farId)
    assert.equal(decryptAccountSecret(row.threads_access_token_encrypted as string), 'far-token')
  })
})

test('refreshExpiringMetaTokens: an already-expired token is never selected (Meta cannot refresh it anyway)', async (t) => {
  await withDb(t, async (pool, { makeAccount, makeProject, readAccount }) => {
    const projectId = await makeProject()
    const expiredId = await makeAccount(projectId, { platform: 'instagram', token: 'expired-token', expiresInDays: -1 })

    const results = await withFetch(
      () => jsonResponse({ access_token: 'should-not-be-used', expires_in: 5184000 }),
      () => refreshExpiringMetaTokens(pool),
    )

    assert.ok(!results.some((r) => r.id === expiredId), 'an already-expired token must not be selected for refresh')
    const row = await readAccount(expiredId)
    assert.equal(decryptAccountSecret(row.instagram_access_token_encrypted as string), 'expired-token')
  })
})

// --- Meta error: connection must not be disabled ---

test('refreshExpiringMetaTokens: a Meta API error is recorded but the still-working connection is NOT disabled', async (t) => {
  await withDb(t, async (pool, { makeAccount, makeProject, readAccount }) => {
    const projectId = await makeProject()
    const id = await makeAccount(projectId, { platform: 'instagram', token: 'soon-to-expire', expiresInDays: 2 })

    const results = await withFetch(
      () => jsonResponse({ error: { message: 'This access token is not eligible to be refreshed at this time.' } }, 400),
      () => refreshExpiringMetaTokens(pool),
    )

    const mine = results.find((r) => r.id === id)
    assert.ok(mine)
    assert.equal(mine!.outcome, 'error')

    const row = await readAccount(id)
    assert.equal(row.status, 'connected', 'a background refresh failure must never flip a working connection to error')
    assert.match(row.connection_error as string, /eligible to be refreshed/)
    // The existing, still-valid token must be left exactly as it was.
    assert.equal(decryptAccountSecret(row.instagram_access_token_encrypted as string), 'soon-to-expire')
  })
})

test('refreshExpiringMetaTokens: one account erroring never blocks or affects another account', async (t) => {
  await withDb(t, async (pool, { makeAccount, makeProject, readAccount }) => {
    const projectId = await makeProject()
    const badId = await makeAccount(projectId, { platform: 'instagram', token: 'bad-token', expiresInDays: 2 })
    const goodId = await makeAccount(projectId, { platform: 'threads', token: 'good-token', expiresInDays: 2 })

    const results = await withFetch(
      (url) => {
        if (url.includes('graph.instagram.com')) return jsonResponse({ error: { message: 'revoked' } }, 400)
        return jsonResponse({ access_token: 'refreshed-good-token', expires_in: 5184000 })
      },
      () => refreshExpiringMetaTokens(pool),
    )

    assert.equal(results.find((r) => r.id === badId)?.outcome, 'error')
    assert.equal(results.find((r) => r.id === goodId)?.outcome, 'refreshed')

    const goodRow = await readAccount(goodId)
    assert.equal(decryptAccountSecret(goodRow.threads_access_token_encrypted as string), 'refreshed-good-token')
  })
})

// --- Concurrent update: never clobber a newer token ---

test('refreshExpiringMetaTokens: a concurrent manual reconnect wins — the sweep never overwrites a newer token', async (t) => {
  await withDb(t, async (pool, { makeAccount, makeProject, readAccount }) => {
    const projectId = await makeProject()
    const id = await makeAccount(projectId, { platform: 'instagram', token: 'stale-snapshot', expiresInDays: 2 })

    // Simulate a human clicking "Recheck connection" (or connecting a brand-new token) AFTER the
    // sweep already read the old ciphertext but BEFORE the sweep's own UPDATE lands — the real
    // regression this guards against: a plain UPDATE with no WHERE-clause pin on the old value
    // would blindly overwrite this newer token with the sweep's own, now-stale, refresh result.
    let sweepUpdateReady: () => void
    const sweepCanProceed = new Promise<void>((resolve) => {
      sweepUpdateReady = resolve
    })

    const results = await withFetch(
      async () => {
        // Right after the sweep read the row and called Meta, race a concurrent manual update in.
        await pool.query(`UPDATE social_accounts SET instagram_access_token_encrypted = $1 WHERE id = $2`, [
          encryptAccountSecret('newer-token-from-manual-reconnect'),
          id,
        ])
        sweepUpdateReady!()
        return jsonResponse({ access_token: 'sweep-refreshed-token', expires_in: 5184000 })
      },
      () => refreshExpiringMetaTokens(pool),
    )
    await sweepCanProceed

    const mine = results.find((r) => r.id === id)
    assert.ok(mine)
    assert.equal(mine!.outcome, 'skipped_raced', 'the sweep must detect the row changed underneath it and discard its own result')

    const row = await readAccount(id)
    assert.equal(
      decryptAccountSecret(row.instagram_access_token_encrypted as string),
      'newer-token-from-manual-reconnect',
      'the newer token must survive untouched',
    )
  })
})

// --- Project isolation ---

test('refreshExpiringMetaTokens: two different projects are each refreshed independently, never cross-matched', async (t) => {
  await withDb(t, async (pool, { makeAccount, makeProject, readAccount }) => {
    const projectA = await makeProject()
    const projectB = await makeProject()
    const idA = await makeAccount(projectA, { platform: 'instagram', token: 'project-a-token', expiresInDays: 1 })
    const idB = await makeAccount(projectB, { platform: 'instagram', token: 'project-b-token', expiresInDays: 1 })

    const results = await withFetch(
      () => jsonResponse({ access_token: 'refreshed-token', expires_in: 5184000 }),
      () => refreshExpiringMetaTokens(pool),
    )

    const resultA = results.find((r) => r.id === idA)
    const resultB = results.find((r) => r.id === idB)
    assert.ok(resultA && resultB)
    assert.equal(resultA!.projectId, projectA)
    assert.equal(resultB!.projectId, projectB)
    assert.equal(resultA!.outcome, 'refreshed')
    assert.equal(resultB!.outcome, 'refreshed')

    // Each project's own row was updated — neither touched the other's.
    const rowA = await readAccount(idA)
    const rowB = await readAccount(idB)
    assert.equal(rowA.project_id, projectA)
    assert.equal(rowB.project_id, projectB)
    assert.equal(decryptAccountSecret(rowA.instagram_access_token_encrypted as string), 'refreshed-token')
    assert.equal(decryptAccountSecret(rowB.instagram_access_token_encrypted as string), 'refreshed-token')
  })
})

test('refreshExpiringMetaTokens: the update statement is always scoped by id AND project_id (no cross-project write possible)', async (t) => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./social-meta-token-refresh-sweep.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /WHERE id = \$3 AND project_id = \$4 AND \$\{cfg\.tokenColumn\} = \$5/,
    'the refresh write must be scoped by both id and project_id, pinned to the exact token snapshot read',
  )
  assert.match(
    source,
    /WHERE id = \$2 AND project_id = \$3 AND \$\{cfg\.tokenColumn\} = \$4/,
    'the error-recording write must also be scoped by both id and project_id, pinned to the exact token snapshot read',
  )
})

// --- No client-UI import from this server-only module ---

test('social-meta-token-refresh-sweep.ts: never imports from components/ (server-only, pulls in `pg` + network calls)', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./social-meta-token-refresh-sweep.ts', import.meta.url), 'utf8')
  assert.ok(!source.includes('components/'), 'this server-only sweep must never import a client component')
  assert.ok(!source.includes("'use client'"), 'this module must never be a client component itself')
})

test('REFRESH_WINDOW_DAYS lives in its own zero-dependency module, imported by both the sweep and the UI', async () => {
  const fs = await import('node:fs/promises')
  const windowSource = await fs.readFile(new URL('./social-meta-token-refresh-window.ts', import.meta.url), 'utf8')
  assert.match(windowSource, /export const REFRESH_WINDOW_DAYS = 7/)
  assert.ok(!/^import /m.test(windowSource), 'the shared constant module must have zero imports of its own')

  const sweepSource = await fs.readFile(new URL('./social-meta-token-refresh-sweep.ts', import.meta.url), 'utf8')
  assert.match(sweepSource, /import \{ REFRESH_WINDOW_DAYS \} from '\.\/social-meta-token-refresh-window\.ts'/)
  assert.ok(
    !sweepSource.includes('export const REFRESH_WINDOW_DAYS') && !sweepSource.includes('export { REFRESH_WINDOW_DAYS }'),
    'the sweep module must not also define or re-export the constant — one source of truth only',
  )

  const uiSource = await fs.readFile(new URL('../components/sections/social-accounts-view.tsx', import.meta.url), 'utf8')
  assert.match(
    uiSource,
    /import \{ REFRESH_WINDOW_DAYS \} from '@\/lib\/social-meta-token-refresh-window'/,
    'the client component must import the constant from the tiny shared module, never from the server-only sweep module',
  )
})

// --- connection_error write must not clobber a connection whose token already updated ---

test('refreshExpiringMetaTokens: a concurrent successful reconnect wins over a STALE refresh-error write — the error is discarded, not the fix', async (t) => {
  await withDb(t, async (pool, { makeAccount, makeProject, readAccount }) => {
    const projectId = await makeProject()
    const id = await makeAccount(projectId, { platform: 'instagram', token: 'about-to-fail', expiresInDays: 2 })

    // Simulate a human successfully reconnecting (a brand-new, working token) in the window
    // between the sweep reading the old ciphertext and its own error-recording write landing —
    // the real regression this guards against: a blind `UPDATE connection_error = ...` with no
    // WHERE-clause pin on the old token would stamp a stale "refresh failed" error onto an
    // account whose connection was actually just fixed by that concurrent reconnect.
    const results = await withFetch(
      async () => {
        await pool.query(`UPDATE social_accounts SET instagram_access_token_encrypted = $1, connection_error = '' WHERE id = $2`, [
          encryptAccountSecret('newer-working-token-from-manual-reconnect'),
          id,
        ])
        return jsonResponse({ error: { message: 'This access token is not eligible to be refreshed at this time.' } }, 400)
      },
      () => refreshExpiringMetaTokens(pool),
    )

    const mine = results.find((r) => r.id === id)
    assert.ok(mine)
    assert.equal(mine!.outcome, 'error', 'the sweep itself still reports its own attempt as an error')

    const row = await readAccount(id)
    assert.equal(row.connection_error, '', 'the stale error must NOT overwrite the now-fixed connection’s clean state')
    assert.equal(
      decryptAccountSecret(row.instagram_access_token_encrypted as string),
      'newer-working-token-from-manual-reconnect',
      'the newer, working token must survive untouched',
    )
  })
})

test('refreshExpiringMetaTokens: with no concurrent change, a genuine refresh error IS recorded normally', async (t) => {
  await withDb(t, async (pool, { makeAccount, makeProject, readAccount }) => {
    const projectId = await makeProject()
    const id = await makeAccount(projectId, { platform: 'threads', token: 'revoked-token', expiresInDays: 2 })

    const results = await withFetch(
      () => jsonResponse({ error: { message: 'Error validating access token: Session has expired.' } }, 400),
      () => refreshExpiringMetaTokens(pool),
    )

    const mine = results.find((r) => r.id === id)
    assert.ok(mine)
    assert.equal(mine!.outcome, 'error')

    const row = await readAccount(id)
    assert.match(row.connection_error as string, /Session has expired/, 'the real error must still be recorded when nothing raced it')
    assert.equal(row.status, 'connected', 'still never disables the connection')
  })
})
