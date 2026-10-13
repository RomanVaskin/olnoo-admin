import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldShowPublishButton,
  shouldShowThreadsPublishButton,
  shouldShowPublishSelectedButton,
} from './social-publications-ui.ts'

test('shouldShowPublishButton: true for every status except published/publishing', () => {
  assert.equal(shouldShowPublishButton('draft'), true)
  assert.equal(shouldShowPublishButton('ready'), true)
  assert.equal(shouldShowPublishButton('failed'), true)
  assert.equal(shouldShowPublishButton('published'), false)
  // PR-2: a 'publishing' row is always gated by the atomic claim anyway — showing a button that's
  // always refused with 409 would just invite a pointless, confusing click.
  assert.equal(shouldShowPublishButton('publishing'), false)
})

test('shows the Publish to Threads button for an unpublished Threads publication', () => {
  assert.equal(shouldShowThreadsPublishButton('threads', 'draft'), true)
  assert.equal(shouldShowThreadsPublishButton('threads', 'ready'), true)
  assert.equal(shouldShowThreadsPublishButton('threads', 'failed'), true)
})

test('hides the button once the Threads publication is already published or is publishing', () => {
  assert.equal(shouldShowThreadsPublishButton('threads', 'published'), false)
  assert.equal(shouldShowThreadsPublishButton('threads', 'publishing'), false)
})

test('never shows the Threads button for another platform', () => {
  assert.equal(shouldShowThreadsPublishButton('telegram', 'draft'), false)
  assert.equal(shouldShowThreadsPublishButton('vk', 'draft'), false)
  assert.equal(shouldShowThreadsPublishButton('instagram', 'draft'), false)
})

test('shows the bulk "Publish selected channels" button while some selected channel is unpublished', () => {
  assert.equal(shouldShowPublishSelectedButton(4, 'draft'), true)
  assert.equal(shouldShowPublishSelectedButton(4, 'ready'), true)
  assert.equal(shouldShowPublishSelectedButton(4, 'partially_published'), true)
})

test('hides the bulk button once every selected channel is published', () => {
  assert.equal(shouldShowPublishSelectedButton(4, 'fully_published'), false)
})

test('hides the bulk button when no channel is selected', () => {
  assert.equal(shouldShowPublishSelectedButton(0, 'draft'), false)
})
