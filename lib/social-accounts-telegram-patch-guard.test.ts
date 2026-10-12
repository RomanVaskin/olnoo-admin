import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// lib/social-accounts.ts imports `@/lib/db` and `@/lib/crm`, which this project's plain
// `node --test` runner cannot resolve directly (same pre-existing limitation documented in
// lib/social-telegram-connection-wiring.test.ts and the Instagram/Threads ownership guard tests).
// This is a static source-regression guard on the specific fix: a plain PATCH/POST must not be
// able to set a Telegram account's username or connected status without going through the
// verified connect endpoint.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

test('updateSocialAccount: a telegram account refuses a direct username or status=connected change', async () => {
  const source = await sourceOf('./social-accounts.ts')
  const fnIdx = source.indexOf('export async function updateSocialAccount')
  assert.ok(fnIdx > 0)
  // The guard must trigger on either a username change or forcing status to 'connected' ...
  const conditionIdx = source.indexOf("typeof input.username === 'string' || input.status === 'connected'", fnIdx)
  assert.ok(conditionIdx > fnIdx, "guard condition must check both input.username and input.status === 'connected'")
  const guardIdx = source.indexOf("targetPlatform === 'telegram'", conditionIdx)
  assert.ok(guardIdx > conditionIdx, 'updateSocialAccount must guard against a telegram target platform')
  // ... and it must return an error (never silently drop the fields and continue).
  const errorIdx = source.indexOf('status: 400', guardIdx)
  assert.ok(errorIdx > guardIdx && errorIdx < guardIdx + 400, 'the guard must refuse with a 400, not silently ignore the fields')
  // The guard must run before the actual UPDATE statement is built.
  const updateIdx = source.indexOf('UPDATE social_accounts SET', guardIdx)
  assert.ok(updateIdx > errorIdx, 'the guard must be checked before the UPDATE is executed')
})

test('updateSocialAccount: switching platform to telegram inherits the stored status, so a PATCH touching only `platform` on an account already status=connected (e.g. a connected vk account) must still be refused', async () => {
  const source = await sourceOf('./social-accounts.ts')
  const fnIdx = source.indexOf('export async function updateSocialAccount')
  assert.ok(fnIdx > 0)
  // The guard must also trigger when ONLY `platform` is part of the PATCH (no `username`, no
  // `status`) — otherwise an account already `status='connected'` from a different platform keeps
  // that status untouched after switching to telegram, since nothing in this PATCH writes `status`
  // at all; the row ends up platform='telegram' + status='connected' with no Telegram API call ever
  // made.
  const conditionIdx = source.indexOf("input.platform !== undefined", fnIdx)
  assert.ok(conditionIdx > fnIdx, 'the guard condition must also trigger on a plain platform change')
  // It must resolve the RESULTANT status (existing stored status if this PATCH doesn't set one),
  // not just whatever `input.status` literally says in this one request.
  const resultantIdx = source.indexOf('resultantStatus = input.status ?? existing?.status', conditionIdx)
  assert.ok(resultantIdx > conditionIdx, "must fall back to the account's existing stored status when this PATCH does not set one")
  const guardIdx = source.indexOf("targetPlatform === 'telegram' && (typeof input.username === 'string' || resultantStatus === 'connected')", resultantIdx)
  assert.ok(guardIdx > conditionIdx, 'the final check must refuse telegram + a resultant connected status, not just an explicit input.status')
})

test('createSocialAccount: a telegram account cannot be created already status=connected', async () => {
  const source = await sourceOf('./social-accounts.ts')
  const fnIdx = source.indexOf('export async function createSocialAccount')
  assert.ok(fnIdx > 0)
  const guardIdx = source.indexOf("input.platform === 'telegram' && input.status === 'connected'", fnIdx)
  assert.ok(guardIdx > fnIdx, 'createSocialAccount must guard against creating an already-connected telegram account')
  const insertIdx = source.indexOf('INSERT INTO social_accounts', guardIdx)
  assert.ok(insertIdx > guardIdx, 'the guard must be checked before the INSERT is executed')
})
