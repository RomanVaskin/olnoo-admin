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

// PR-2
test('publishing -> ready is forbidden (same duplication risk: it erases the one guard — status !== \'published\'/\'publishing\' — that keeps a retry from re-sending)', () => {
  assert.equal(isForbiddenPublicationStatusTransition('publishing', 'ready'), true)
})

test('every other transition out of "publishing" is allowed — a human resolving a stuck row must still be able to set it to failed/published directly', () => {
  assert.equal(isForbiddenPublicationStatusTransition('publishing', 'failed'), false)
  assert.equal(isForbiddenPublicationStatusTransition('publishing', 'published'), false)
  assert.equal(isForbiddenPublicationStatusTransition('publishing', 'publishing'), false)
})
