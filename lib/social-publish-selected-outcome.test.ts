import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outcomeFromPublisherResult } from './social-publish-selected-outcome.ts'

test('a published row maps to outcome "published" with its external_url', () => {
  const result = outcomeFromPublisherResult({ row: { status: 'published', external_url: 'https://t.me/x/1' } }, '')
  assert.deepEqual(result, { outcome: 'published', externalUrl: 'https://t.me/x/1', error: '' })
})

test('a failed row maps to outcome "failed" with its error message', () => {
  const result = outcomeFromPublisherResult({ row: { status: 'failed', error: 'chat not found' } }, '')
  assert.deepEqual(result, { outcome: 'failed', externalUrl: '', error: 'chat not found' })
})

test('a failed row with no error message still gets a fallback message', () => {
  const result = outcomeFromPublisherResult({ row: { status: 'failed', error: '' } }, '')
  assert.deepEqual(result, { outcome: 'failed', externalUrl: '', error: 'Publish failed' })
})

test('a 409 (already published) pre-flight error maps to "already_published", not "failed"', () => {
  const result = outcomeFromPublisherResult(
    { error: 'this publication is already published', status: 409 },
    'https://vk.com/wall-1_2',
  )
  assert.deepEqual(result, { outcome: 'already_published', externalUrl: 'https://vk.com/wall-1_2', error: '' })
})

test('a non-409 pre-flight error (e.g. missing Instagram image) maps to "failed" with its message', () => {
  const result = outcomeFromPublisherResult(
    { error: 'post has no Instagram image URL to publish', status: 400 },
    '',
  )
  assert.deepEqual(result, { outcome: 'failed', externalUrl: '', error: 'post has no Instagram image URL to publish' })
})

// PR-2
test('a 409 claim conflict (lib/social-publication-claim.ts — a concurrent attempt or a stuck "publishing" row) also maps to "already_published", not "failed"', () => {
  const result = outcomeFromPublisherResult(
    {
      error:
        'this publication is already being published, or a previous attempt never finished — check the platform directly before retrying',
      status: 409,
    },
    '',
  )
  assert.equal(result.outcome, 'already_published')
})

test('a 503 (send outcome unknown — timeout/dropped connection, never got a response from the platform) maps to "unknown", never "failed"', () => {
  const result = outcomeFromPublisherResult(
    { error: 'Could not confirm whether Telegram received the message: fetch failed', status: 503 },
    '',
  )
  assert.deepEqual(result, {
    outcome: 'unknown',
    externalUrl: '',
    error: 'Could not confirm whether Telegram received the message: fetch failed',
  })
})
