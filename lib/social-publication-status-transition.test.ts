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

test('"ready" reached from anywhere other than "published" is allowed (not a blanket lock on "ready")', () => {
  assert.equal(isForbiddenPublicationStatusTransition('draft', 'ready'), false)
  assert.equal(isForbiddenPublicationStatusTransition('failed', 'ready'), false)
  assert.equal(isForbiddenPublicationStatusTransition('ready', 'ready'), false)
})
