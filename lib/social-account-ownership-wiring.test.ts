import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// lib/social-instagram.ts and lib/social-threads.ts import `@/lib/crm` (pre-existing, for
// resolveProjectId — same as every other Social module file), so this project's plain
// `node --test` runner (no path-alias loader; see package.json's "test" script) cannot resolve
// and execute them directly, the same way `@/lib/crm`'s own resolveProjectId has no direct unit
// test in this repo either. Rewriting either publisher to remove that import was out of scope
// (explicitly: "не переписывать существующие публикаторы").
//
// So this is a static regression guard on the source text instead — same pattern already used
// elsewhere in this family of repos for exactly this situation. It fails immediately if the
// ownership guard is ever removed, reordered to run after a publish-affecting API call, or
// changed to not actually block on a failed check. The guard's own decision logic
// (compareAccountOwnership) is fully executed and covered by social-account-ownership.test.ts.
// The full flow (DB + mocked Instagram/Threads API) was verified manually against a real local
// Postgres — see this change's PR description for the three scenarios run and their results.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

function assertGuardedBeforeFirstCall(source: string, firstPublishCall: string, label: string) {
  const importIdx = source.indexOf("from '@/lib/social-account-ownership'")
  assert.ok(importIdx > 0, `${label}: must import compareAccountOwnership`)

  const ownershipCallIdx = source.indexOf('compareAccountOwnership(')
  assert.ok(ownershipCallIdx > importIdx, `${label}: must call compareAccountOwnership`)

  const blockIdx = source.indexOf('if (!ownership.ok) return', ownershipCallIdx)
  assert.ok(blockIdx > ownershipCallIdx, `${label}: a failed ownership check must return immediately`)

  const firstCallIdx = source.indexOf(firstPublishCall)
  assert.ok(firstCallIdx > 0, `${label}: expected to find the first publish-affecting API call`)
  assert.ok(ownershipCallIdx < firstCallIdx, `${label}: ownership must be checked before ${firstPublishCall}`)

  // The env-credentials guard must still come first (unrelated to ownership, but ownership can't
  // run meaningfully without a token) — never removed by this change.
  assert.match(source, /is not configured on the server/, `${label}: env-credential guard must remain`)
}

test('lib/social-instagram.ts: ownership guard runs before the media container is created', async () => {
  const source = await sourceOf('./social-instagram.ts')
  assertGuardedBeforeFirstCall(source, '/media`', 'instagram')
})

test('lib/social-threads.ts: ownership guard runs before the text container is created', async () => {
  const source = await sourceOf('./social-threads.ts')
  assertGuardedBeforeFirstCall(source, '/threads`', 'threads')
})
