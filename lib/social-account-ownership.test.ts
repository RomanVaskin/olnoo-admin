import test from 'node:test'
import assert from 'node:assert/strict'
import { compareAccountOwnership, resolveOwnerProjectSlug, verifyProjectIsAllowed } from './social-account-ownership.ts'

// This is the actual decision behind the Instagram/Threads ownership guard (wired into
// lib/social-instagram.ts / lib/social-threads.ts — see those files' own tests for why the
// guard itself isn't exercised end-to-end here).

test('matching handle (case/whitespace/@-insensitive) -> ok', () => {
  assert.deepEqual(compareAccountOwnership('Instagram', 'driveset_official', 'driveset_official'), { ok: true })
  assert.deepEqual(compareAccountOwnership('Instagram', '@DriveSet_Official', 'driveset_official'), { ok: true })
  assert.deepEqual(compareAccountOwnership('Instagram', '  driveset_official  ', '@driveset_official'), { ok: true })
})

test('a real mismatch is blocked: never publish project A content to project B\'s account', () => {
  const result = compareAccountOwnership('Instagram', 'driveset_official', 'some_other_clients_account')
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('driveset_official'))
  assert.ok(!result.ok && result.error.includes('some_other_clients_account'))
})

test('blank project username -> blocked, ownership is never guessed', () => {
  for (const blank of ['', '   ', undefined, null]) {
    const result = compareAccountOwnership('Instagram', blank as never, 'whatever_the_api_returned')
    assert.equal(result.ok, false)
    assert.ok(!result.ok && /username is not set/i.test(result.error))
  }
})

test('the API returning no username at all -> blocked, never assumed to match', () => {
  for (const blank of ['', undefined, null]) {
    const result = compareAccountOwnership('Threads', 'driveset_official', blank as never)
    assert.equal(result.ok, false)
    assert.ok(!result.ok && /did not return a username/i.test(result.error))
  }
})

test('error messages name the actual platform passed in (Instagram vs Threads)', () => {
  const ig = compareAccountOwnership('Instagram', '', 'x')
  const th = compareAccountOwnership('Threads', '', 'x')
  assert.ok(!ig.ok && ig.error.includes('Instagram'))
  assert.ok(!th.ok && th.error.includes('Threads'))
})

// --- resolveOwnerProjectSlug / verifyProjectIsAllowed: the actual authorization (project_id/slug
// pin), added because username alone is user-editable and not unique — two projects could set
// the same username and both pass a username-only check (see the dedicated test below).

test('resolveOwnerProjectSlug: trims and lower-cases; unset/blank -> null', () => {
  assert.equal(resolveOwnerProjectSlug('  DriveSet  '), 'driveset')
  assert.equal(resolveOwnerProjectSlug(''), null)
  assert.equal(resolveOwnerProjectSlug(undefined), null)
  assert.equal(resolveOwnerProjectSlug(null), null)
})

test('verifyProjectIsAllowed: the one configured owner project is allowed', () => {
  assert.deepEqual(verifyProjectIsAllowed('Instagram', 'INSTAGRAM_OWNER_PROJECT', 'driveset', 'driveset'), { ok: true })
  assert.deepEqual(verifyProjectIsAllowed('Instagram', 'INSTAGRAM_OWNER_PROJECT', 'driveset', 'DriveSet'), { ok: true })
})

test('verifyProjectIsAllowed: no owner configured -> every project is blocked (fail closed)', () => {
  const result = verifyProjectIsAllowed('Instagram', 'INSTAGRAM_OWNER_PROJECT', null, 'driveset')
  assert.equal(result.ok, false)
  assert.ok(!result.ok && /INSTAGRAM_OWNER_PROJECT is not configured/.test(result.error))
})

test('verifyProjectIsAllowed: a different project is blocked even though it is a real, known project', () => {
  const result = verifyProjectIsAllowed('Instagram', 'INSTAGRAM_OWNER_PROJECT', 'driveset', 'olnoo')
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.error.includes('driveset'))
})

// The exact scenario this patch exists for: two projects whose social_accounts.username happens
// to be identical (editable, not unique) must not both be allowed to publish through one global
// token -- only the one project named by the owner-project env var ever passes.
test('two projects sharing the same social_accounts.username: only the configured owner project is authorized', () => {
  const sharedUsername = 'shared_handle'
  const ownerProject = resolveOwnerProjectSlug('driveset')

  const driveset = verifyProjectIsAllowed('Instagram', 'INSTAGRAM_OWNER_PROJECT', ownerProject, 'driveset')
  const otherProject = verifyProjectIsAllowed('Instagram', 'INSTAGRAM_OWNER_PROJECT', ownerProject, 'some-other-project')

  assert.equal(driveset.ok, true)
  assert.equal(otherProject.ok, false)

  // Even if both projects' social_accounts rows have the identical username, the username check
  // alone would have passed for both -- proving it was never sufficient on its own.
  assert.deepEqual(compareAccountOwnership('Instagram', sharedUsername, sharedUsername), { ok: true })
  // The project gate above is what actually prevents "some-other-project" from ever reaching that
  // username check in the real publisher (see lib/social-instagram.ts / lib/social-threads.ts:
  // verifyProjectIsAllowed runs first and returns before compareAccountOwnership is even called).
})
