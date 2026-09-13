import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldShowThreadsPublishButton } from './social-publications-ui.ts'

test('shows the Publish to Threads button for an unpublished Threads publication', () => {
  assert.equal(shouldShowThreadsPublishButton('threads', 'draft'), true)
  assert.equal(shouldShowThreadsPublishButton('threads', 'ready'), true)
  assert.equal(shouldShowThreadsPublishButton('threads', 'failed'), true)
})

test('hides the button once the Threads publication is already published', () => {
  assert.equal(shouldShowThreadsPublishButton('threads', 'published'), false)
})

test('never shows the Threads button for another platform', () => {
  assert.equal(shouldShowThreadsPublishButton('telegram', 'draft'), false)
  assert.equal(shouldShowThreadsPublishButton('vk', 'draft'), false)
  assert.equal(shouldShowThreadsPublishButton('instagram', 'draft'), false)
})
