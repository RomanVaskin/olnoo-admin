import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text — these files import `@/lib/...` (db, crm, social),
// which this project's plain `node --test` runner cannot resolve (same pre-existing limitation as
// lib/social-account-ownership-wiring.test.ts explains for Instagram/Threads). The two things this
// guards against regressing are the actual security properties of this change:
//   1. No column that could expose a VK token in plaintext is ever selected by the accounts list/
//      detail API's column allowlist.
//   2. lib/social-vk.ts's publisher no longer reads a shared global VK_ACCESS_TOKEN — every
//      credential it uses comes from the specific social_accounts row it already resolved,
//      project-scoped.
// lib/social-vk-verify.ts's own logic (the VK API call + response parsing) is fully executed and
// covered by social-vk-verify.test.ts; lib/social-account-crypto.ts's logic is covered by
// social-account-crypto.test.ts.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

test('lib/social-accounts.ts: ACCOUNT_COLUMNS never selects the encrypted VK token', async () => {
  const source = await sourceOf('./social-accounts.ts')
  const match = source.match(/const ACCOUNT_COLUMNS\s*=\s*([\s\S]*?)\n\n/)
  assert.ok(match, 'expected to find the ACCOUNT_COLUMNS definition')
  const definition = match[1]
  assert.ok(!definition.includes('vk_access_token_encrypted'), 'ACCOUNT_COLUMNS must not select vk_access_token_encrypted')
  assert.ok(definition.includes('id'), 'sanity check: this really matched the column list')
})

test('lib/social-vk.ts: publishing never reads a global VK_ACCESS_TOKEN env var', async () => {
  const source = await sourceOf('./social-vk.ts')
  assert.ok(
    !source.includes('process.env.VK_ACCESS_TOKEN'),
    'lib/social-vk.ts must not read the old global VK_ACCESS_TOKEN env var (mentioning it in a comment, e.g. explaining its removal, is fine)',
  )
  assert.match(source, /vk_access_token_encrypted/, 'must read the per-account encrypted token column')
  assert.match(source, /decryptAccountSecret/, 'must decrypt the per-account token rather than reading plaintext')
})

test('lib/social-vk.ts: a missing per-account token blocks publishing with a clear error, never a fallback', async () => {
  const source = await sourceOf('./social-vk.ts')
  const idx = source.indexOf('!account.vk_access_token_encrypted')
  assert.ok(idx > 0, 'must check for a connected token before anything else credential-related')
  const returnIdx = source.indexOf('return {', idx)
  assert.ok(returnIdx > idx && returnIdx < idx + 200, 'the missing-token check must return immediately')
})

test('lib/social-accounts-vk-connection.ts: a failed replacement-token attempt never overwrites a working connection', async () => {
  const source = await sourceOf('./social-accounts-vk-connection.ts')
  assert.match(source, /isRecheckOfStoredToken/)
  const condIdx = source.indexOf('if (isRecheckOfStoredToken)')
  assert.ok(condIdx > 0, 'must branch on whether this is a recheck of the stored token vs a new/replacement token')
  // Only the recheck branch may write status='error' to the database on a verification failure.
  const beforeCond = source.slice(0, condIdx)
  assert.ok(!beforeCond.includes("status = 'error'"), "no DB write of status='error' before the recheck-only branch")
})
