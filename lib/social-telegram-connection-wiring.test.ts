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
