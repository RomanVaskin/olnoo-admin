import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldAttemptPublicationTarget } from './social-publish-selected-targets.ts'

test('retryFailed=true (manual retry): every non-published status is attempted, including "failed"', () => {
  assert.equal(shouldAttemptPublicationTarget('draft', true), true)
  assert.equal(shouldAttemptPublicationTarget('ready', true), true)
  assert.equal(shouldAttemptPublicationTarget('failed', true), true)
})

test('retryFailed=false (scheduler): "failed" is skipped, everything else still attempted', () => {
  assert.equal(shouldAttemptPublicationTarget('failed', false), false)
  assert.equal(shouldAttemptPublicationTarget('draft', false), true)
  assert.equal(shouldAttemptPublicationTarget('ready', false), true)
})

// 'published' isn't filtered here at all — the caller (publishSelectedChannels) already handles
// it separately as 'already_published' before this decision even applies. Documented for clarity,
// not because this function treats it specially.
test('"published" is not specially excluded by this function either way', () => {
  assert.equal(shouldAttemptPublicationTarget('published', true), true)
  assert.equal(shouldAttemptPublicationTarget('published', false), true)
})

// PR-2: 'publishing' (a concurrent attempt in flight, or a stuck row with an unknown real-world
// outcome) must never be auto- OR manually-attempted through this filter, regardless of
// retryFailed — only a human directly resolving the row (not via publishSelectedChannels at all)
// can move it out of this state.
test('"publishing" is never attempted, by either caller, regardless of retryFailed', () => {
  assert.equal(shouldAttemptPublicationTarget('publishing', true), false)
  assert.equal(shouldAttemptPublicationTarget('publishing', false), false)
})
