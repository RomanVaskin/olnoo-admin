import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveInstagramPublishOutcome } from './social-instagram-publish-outcome.ts'

test('media_publish succeeded + permalink fetched: published with both ids', () => {
  const outcome = resolveInstagramPublishOutcome('media123', 'https://instagram.com/p/abc', null)
  assert.deepEqual(outcome, { status: 'published', externalPostId: 'media123', externalUrl: 'https://instagram.com/p/abc' })
})

// The exact regression this guards against: media_publish succeeded (mediaId is set), but the
// trailing permalink lookup failed or returned nothing, and/or left an error message behind. The
// post is already live on Instagram at this point — this must still be reported as 'published',
// never 'failed' (a 'failed' row would no longer trip the "already published" 409 guard, so a
// retry would call media_publish a second time and create a duplicate post).
test('media_publish succeeded but permalink lookup failed: still published, with a blank external URL, igError ignored', () => {
  const outcome = resolveInstagramPublishOutcome('media123', null, 'Instagram API request failed (500)')
  assert.deepEqual(outcome, { status: 'published', externalPostId: 'media123', externalUrl: '' })
})

test('media_publish succeeded, permalink lookup threw (mediaId survives the catch block): still published', () => {
  const outcome = resolveInstagramPublishOutcome('media123', null, 'fetch failed: network error')
  assert.deepEqual(outcome, { status: 'published', externalPostId: 'media123', externalUrl: '' })
})

test('media_publish itself never returned a media id: failed, with the real error message', () => {
  const outcome = resolveInstagramPublishOutcome(null, null, 'Instagram API request failed (400)')
  assert.deepEqual(outcome, { status: 'failed', error: 'Instagram API request failed (400)' })
})

test('no media id and no error message at all: failed, with a fallback message', () => {
  const outcome = resolveInstagramPublishOutcome(null, null, null)
  assert.deepEqual(outcome, { status: 'failed', error: 'Instagram did not return a published media id' })
})
