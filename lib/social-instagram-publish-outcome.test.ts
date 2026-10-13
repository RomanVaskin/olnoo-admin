import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveInstagramPublishOutcome } from './social-instagram-publish-outcome.ts'

test('media_publish succeeded + permalink fetched: published with both ids', () => {
  const outcome = resolveInstagramPublishOutcome('media123', 'https://instagram.com/p/abc', null, false)
  assert.deepEqual(outcome, { status: 'published', externalPostId: 'media123', externalUrl: 'https://instagram.com/p/abc' })
})

// The exact regression this guards against: media_publish succeeded (mediaId is set), but the
// trailing permalink lookup failed or returned nothing, and/or left an error message behind. The
// post is already live on Instagram at this point — this must still be reported as 'published',
// never 'failed' (a 'failed' row would no longer trip the "already published" 409 guard, so a
// retry would call media_publish a second time and create a duplicate post).
test('media_publish succeeded but permalink lookup failed: still published, with a blank external URL, igError ignored', () => {
  const outcome = resolveInstagramPublishOutcome('media123', null, 'Instagram API request failed (500)', false)
  assert.deepEqual(outcome, { status: 'published', externalPostId: 'media123', externalUrl: '' })
})

test('media_publish succeeded, permalink lookup threw (mediaId survives the catch block): still published', () => {
  const outcome = resolveInstagramPublishOutcome('media123', null, 'fetch failed: network error', false)
  assert.deepEqual(outcome, { status: 'published', externalPostId: 'media123', externalUrl: '' })
})

// mediaId being set always wins, even if (hypothetically) sendOutcomeUnknown were also true — once
// media_publish actually returned an id, the send is confirmed, full stop.
test('media_publish succeeded: published even if sendOutcomeUnknown is (impossibly) also true', () => {
  const outcome = resolveInstagramPublishOutcome('media123', null, null, true)
  assert.equal(outcome.status, 'published')
})

test('media_publish itself never returned a media id, and a definitive error response was received: failed, with the real error message', () => {
  const outcome = resolveInstagramPublishOutcome(null, null, 'Instagram API request failed (400)', false)
  assert.deepEqual(outcome, { status: 'failed', error: 'Instagram API request failed (400)' })
})

test('no media id and no error message at all: failed, with a fallback message', () => {
  const outcome = resolveInstagramPublishOutcome(null, null, null, false)
  assert.deepEqual(outcome, { status: 'failed', error: 'Instagram did not return a published media id' })
})

// PR-2: the exact regression this guards against — the media_publish call itself never got a
// response (its own fetch() threw: a timeout, a dropped connection). The content may or may not
// have actually reached Instagram; this must be reported as 'unknown', never 'failed' — a 'failed'
// row would be safe to retry, but a retry here could create a real duplicate post.
test('media_publish call itself threw (sendOutcomeUnknown): unknown, with the real error message, never failed', () => {
  const outcome = resolveInstagramPublishOutcome(null, null, 'fetch failed: socket hang up', true)
  assert.deepEqual(outcome, { status: 'unknown', error: 'fetch failed: socket hang up' })
})

test('media_publish call itself threw, no error message captured: unknown, with a fallback message', () => {
  const outcome = resolveInstagramPublishOutcome(null, null, null, true)
  assert.deepEqual(outcome, { status: 'unknown', error: 'Could not confirm whether Instagram received the publish request' })
})
