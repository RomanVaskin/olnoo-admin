import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isForbiddenPublicationStatusTransition } from './social-publication-status-transition.ts'

test('published -> ready is forbidden (the exact duplication risk this guards against)', () => {
  assert.equal(isForbiddenPublicationStatusTransition('published', 'ready'), true)
})

test('every other transition out of "published" is allowed', () => {
  assert.equal(isForbiddenPublicationStatusTransition('published', 'published'), false)
  assert.equal(isForbiddenPublicationStatusTransition('published', 'draft'), false)
  assert.equal(isForbiddenPublicationStatusTransition('published', 'failed'), false)
})

test('"ready" reached from draft/failed/ready is allowed (not a blanket lock on "ready")', () => {
  assert.equal(isForbiddenPublicationStatusTransition('draft', 'ready'), false)
  assert.equal(isForbiddenPublicationStatusTransition('failed', 'ready'), false)
  assert.equal(isForbiddenPublicationStatusTransition('ready', 'ready'), false)
})

// PR-2 (review follow-up): 'publishing' is now immutable through this generic status PATCH in
// EVERY direction, not just -> ready. A plain PATCH has no way to tell "genuinely stuck" apart
// from "a send is actively in flight right now" — allowing ANY exit (even -> failed) risked a
// second, independent claim succeeding and sending a real duplicate while the first attempt was
// still running, which is exactly the race lib/social-publication-claim.ts exists to prevent.
test('every transition OUT of "publishing" is forbidden, not just -> ready', () => {
  assert.equal(isForbiddenPublicationStatusTransition('publishing', 'ready'), true)
  assert.equal(isForbiddenPublicationStatusTransition('publishing', 'failed'), true)
  assert.equal(isForbiddenPublicationStatusTransition('publishing', 'published'), true)
  assert.equal(isForbiddenPublicationStatusTransition('publishing', 'draft'), true)
  assert.equal(isForbiddenPublicationStatusTransition('publishing', 'publishing'), true)
})
