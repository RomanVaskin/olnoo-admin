import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text — lib/social-accounts-telegram-connection.ts imports
// `@/lib/db` and `@/lib/crm`, which this project's plain `node --test` runner cannot resolve (same
// pre-existing limitation as lib/social-vk-credentials-wiring.test.ts explains). The actual
// verification logic (lib/social-telegram-verify.ts) is fully executed and covered by
// social-telegram-verify.test.ts; this guards the two properties that only exist once the DB is
// wired in: a failed replacement attempt never overwrites a working connection, and the
// cross-project duplicate-channel check actually runs before a connection is persisted.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

test('lib/social-accounts-telegram-connection.ts: a failed replacement attempt never overwrites a working connection', async () => {
  const source = await sourceOf('./social-accounts-telegram-connection.ts')
  assert.match(source, /isRecheckOfStoredIdentifier/)
  const condIdx = source.indexOf('if (isRecheckOfStoredIdentifier)')
  assert.ok(condIdx > 0, 'must branch on whether this is a recheck of the stored identifier vs a new/replacement one')
  const beforeCond = source.slice(0, condIdx)
  assert.ok(!beforeCond.includes("status = 'error'"), "no DB write of status='error' before the recheck-only branch")
})

test('lib/social-accounts-telegram-connection.ts: the cross-project duplicate-channel check runs before the connection is persisted', async () => {
  const source = await sourceOf('./social-accounts-telegram-connection.ts')
  const conflictQueryIdx = source.indexOf('SELECT id, project_id FROM social_accounts')
  assert.ok(conflictQueryIdx > 0, 'must query for other projects already connected to the same channel')
  const conflictCheckIdx = source.indexOf('conflicts.some')
  assert.ok(conflictCheckIdx > conflictQueryIdx)
  const refusalIdx = source.indexOf("status: 409", conflictCheckIdx)
  assert.ok(refusalIdx > conflictCheckIdx && refusalIdx < conflictCheckIdx + 300, 'a conflict must be refused with 409')
  const persistIdx = source.indexOf("status = 'connected'", refusalIdx)
  assert.ok(persistIdx > refusalIdx, 'the success write must come after the conflict check, never before it')
})

test('lib/social-accounts-telegram-connection.ts: no new per-project bot token is read — the shared TELEGRAM_BOT_TOKEN is reused', async () => {
  const source = await sourceOf('./social-accounts-telegram-connection.ts')
  assert.match(source, /process\.env\.TELEGRAM_BOT_TOKEN/)
  assert.ok(!/BOT_TOKEN_[A-Z_]+/.test(source), 'must not introduce a per-project bot token env var')
})

test('lib/social-accounts-telegram-connection.ts: the duplicate-channel check and the write are inside one advisory-locked transaction (race safety)', async () => {
  const source = await sourceOf('./social-accounts-telegram-connection.ts')
  const beginIdx = source.indexOf("client.query('BEGIN')")
  assert.ok(beginIdx > 0, 'must start an explicit transaction before the conflict check')
  const lockIdx = source.indexOf('pg_advisory_xact_lock', beginIdx)
  assert.ok(lockIdx > beginIdx, 'must acquire an advisory lock right after BEGIN, before the conflict check')
  const conflictIdx = source.indexOf("status = 'connected' AND lower(username)", lockIdx)
  assert.ok(conflictIdx > lockIdx, 'the conflict check must run after the lock is held')
  const writeIdx = source.indexOf("SET username = $1", conflictIdx)
  assert.ok(writeIdx > conflictIdx, 'the write must come after the conflict check, inside the same lock')
  const commitIdx = source.indexOf("client.query('COMMIT')", writeIdx)
  assert.ok(commitIdx > writeIdx, 'must commit after the write, releasing the lock')
  // Every query between BEGIN and COMMIT must run on the dedicated `client`, not the shared `pool`
  // — otherwise the transaction (and the lock with it) would not actually wrap them.
  const txBody = source.slice(beginIdx, commitIdx)
  assert.ok(!/\bpool\.query/.test(txBody), 'no query inside the transaction body may bypass it by using `pool.query` directly')
})

test('lib/social-accounts-telegram-connection.ts: storage and conflict detection both key on the confirmed chat identity, not raw admin-typed text', async () => {
  const source = await sourceOf('./social-accounts-telegram-connection.ts')
  assert.match(source, /canonicalChatIdentifier/, 'must derive a canonical identifier from the verified Telegram identity')
  const fnIdx = source.indexOf('function canonicalChatIdentifier')
  assert.ok(fnIdx > 0)
  assert.match(source.slice(fnIdx, fnIdx + 300), /identity\.chatId/, 'must fall back to the confirmed chat.id, not the raw typed identifier, for channels with no public username')
})
