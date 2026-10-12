import test from 'node:test'
import assert from 'node:assert/strict'
import { compareAccountOwnership } from './social-account-ownership.ts'

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
