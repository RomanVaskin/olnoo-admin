import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text — lib/social-instagram.ts and lib/social-threads.ts
// import `@/lib/...`, which this project's plain `node --test` runner cannot resolve (same
// pre-existing limitation as lib/social-account-ownership-wiring.test.ts and
// lib/social-vk-credentials-wiring.test.ts explain). This guards the actual security properties of
// the Social Connect MVP (per-account Instagram/Threads credentials):
//   1. No column that could expose a plaintext Instagram/Threads token is ever selected by the
//      accounts list/detail API's column allowlist.
//   2. Each publisher prefers the linked account's own encrypted token over the global env
//      fallback, and only falls back to the (still OWNER_PROJECT-gated) env credentials when the
//      account has none.
//   3. An expired per-account token blocks publishing with a clear error instead of being used, or
//      silently falling back to the global (wrong-account) credentials.
//   4. A successful connect/recheck always writes Meta's own verified username onto the account
//      row — never keeps a stale/mistyped `username` that was typed in before a DIFFERENT real
//      identity was confirmed (review fix: the UI's displayed account must never diverge from the
//      one the publisher actually holds a token for).
// lib/social-instagram-verify.ts / lib/social-threads-verify.ts / lib/social-meta-token-refresh.ts
// have their own direct unit tests; lib/social-account-ownership-wiring.test.ts already covers the
// unchanged env-fallback gate's own ordering guarantees.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

test('lib/social-accounts.ts: ACCOUNT_COLUMNS never selects the encrypted Instagram/Threads tokens', async () => {
  const source = await sourceOf('./social-accounts.ts')
  const match = source.match(/const ACCOUNT_COLUMNS\s*=\s*([\s\S]*?)\n\n/)
  assert.ok(match, 'expected to find the ACCOUNT_COLUMNS definition')
  const definition = match[1]
  assert.ok(!definition.includes('instagram_access_token_encrypted'))
  assert.ok(!definition.includes('threads_access_token_encrypted'))
  assert.ok(definition.includes('instagram_account_id'), 'the non-secret resolved id must still be exposed')
  assert.ok(definition.includes('threads_user_id'), 'the non-secret resolved id must still be exposed')
})

for (const [file, platformLabel, tokenColumn, idColumn, expiresColumn, ownerEnvVar] of [
  ['./social-instagram.ts', 'Instagram', 'instagram_access_token_encrypted', 'instagram_account_id', 'instagram_token_expires_at', 'INSTAGRAM_OWNER_PROJECT'],
  ['./social-threads.ts', 'Threads', 'threads_access_token_encrypted', 'threads_user_id', 'threads_token_expires_at', 'THREADS_OWNER_PROJECT'],
] as const) {
  test(`${file}: decrypts and prefers the per-account token over the global env fallback`, async () => {
    const source = await sourceOf(file)
    assert.match(source, /import \{ decryptAccountSecret \} from '@\/lib\/social-account-crypto'/, `${platformLabel}: must import decryptAccountSecret`)
    assert.match(source, new RegExp(tokenColumn), `${platformLabel}: must read the per-account encrypted token column`)
    assert.match(source, new RegExp(idColumn), `${platformLabel}: must read the per-account resolved id column`)

    const branchIdx = source.indexOf(`if (account.${tokenColumn})`)
    assert.ok(branchIdx > 0, `${platformLabel}: must branch on whether a per-account token is stored`)
    const elseIdx = source.indexOf('} else {', branchIdx)
    assert.ok(elseIdx > branchIdx, `${platformLabel}: must have an else branch for the env fallback`)

    const accountBranch = source.slice(branchIdx, elseIdx)
    assert.match(accountBranch, /decryptAccountSecret\(account\.\w+_access_token_encrypted\)/, `${platformLabel}: the account branch must decrypt the stored token`)
    assert.ok(!accountBranch.includes('verifyProjectIsAllowed'), `${platformLabel}: the per-account branch must NOT run the global ownership gate`)
    assert.ok(!accountBranch.includes('compareAccountOwnership'), `${platformLabel}: the per-account branch must NOT run the global ownership gate`)

    const elseBranchEnd = source.indexOf('\n  }', elseIdx)
    const envBranch = source.slice(elseIdx, elseBranchEnd > 0 ? elseBranchEnd : elseIdx + 1600)
    assert.ok(envBranch.includes('verifyProjectIsAllowed'), `${platformLabel}: the env-fallback branch must still run the OWNER_PROJECT gate`)
    assert.ok(envBranch.includes('compareAccountOwnership'), `${platformLabel}: the env-fallback branch must still run the username sanity check`)
    assert.ok(envBranch.includes(ownerEnvVar), `${platformLabel}: the env-fallback branch must still reference ${ownerEnvVar}`)
  })

  test(`${file}: an expired per-account token blocks publishing with a clear error instead of being used or falling back`, async () => {
    const source = await sourceOf(file)
    assert.match(source, new RegExp(`account\\.${expiresColumn} && new Date\\(account\\.${expiresColumn}\\) <= new Date\\(\\)`))
    const expiredIdx = source.indexOf(`if (account.${expiresColumn}`)
    assert.ok(expiredIdx > 0, `${platformLabel}: expected to find the expiry check`)
    const block = source.slice(expiredIdx, expiredIdx + 600)
    assert.match(block, /has expired/i)
    assert.match(block, /await recordPublicationPreflightFailure\(pool, id, projectId, error\)/)
    assert.match(block, /return \{ error, status: 403 \}/)
  })
}

// --- Review fix: username always trusts Meta's verified identity, never a stale manual value ---

for (const [file, platformLabel] of [
  ['./social-accounts-instagram-connection.ts', 'Instagram'],
  ['./social-accounts-threads-connection.ts', 'Threads'],
] as const) {
  test(`${file}: nextUsername prefers verified.identity.username over the pre-existing account.username`, async () => {
    const source = await sourceOf(file)
    assert.match(
      source,
      /const nextUsername = verified\.identity\.username \|\| account\.username\?\.trim\(\) \|\| ''/,
      `${platformLabel}: a successful connect/recheck must always prefer Meta's verified identity over whatever username was there before`,
    )
    assert.ok(
      !source.includes("account.username?.trim() || verified.identity.username"),
      `${platformLabel}: must not fall back to the old "keep the existing value, only fill if empty" order`,
    )
  })
}
