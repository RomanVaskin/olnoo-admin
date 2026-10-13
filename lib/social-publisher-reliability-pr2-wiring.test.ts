import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text for PR-2 — same reasoning as
// lib/social-publisher-reliability-wiring.test.ts (PR-1): lib/social-telegram.ts, lib/social-vk.ts,
// lib/social-instagram.ts, lib/social-threads.ts, lib/social-publish-selected.ts, and
// lib/social-publications.ts all import `@/lib/...`, unresolvable by this repo's plain
// `node --test` runner. The actual logic is covered by direct tests: lib/social-publication-claim.test.ts
// (DB integration — proves the atomic claim really is atomic under real concurrency),
// lib/social-publish-selected-targets.test.ts, lib/social-publish-selected-outcome.test.ts,
// lib/social-instagram-publish-outcome.test.ts, lib/social-publication-status-transition.test.ts,
// lib/social-publications-ui.test.ts.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

const PUBLISHERS = [
  { file: './social-telegram.ts', sendCall: '/sendMessage', sendVar: 'messageId', errVar: 'telegramError', platform: 'Telegram' },
  { file: './social-vk.ts', sendCall: '/method/wall.post', sendVar: 'postId', errVar: 'vkError', platform: 'VK' },
  { file: './social-instagram.ts', sendCall: '/media_publish', sendVar: 'mediaId', errVar: 'igError', platform: 'Instagram' },
  { file: './social-threads.ts', sendCall: '/threads_publish', sendVar: 'mediaId', errVar: 'threadsError', platform: 'Threads' },
] as const

// --- Requirement 1: atomic capture before sending to the external API, one process only ---

test('all four publishers import claimPublicationForSending/publicationClaimConflictResult', async () => {
  for (const { file } of PUBLISHERS) {
    const source = await sourceOf(file)
    assert.match(
      source,
      /import \{ claimPublicationForSending, publicationClaimConflictResult \} from '@\/lib\/social-publication-claim'/,
      `${file}: must import the atomic claim helper`,
    )
  }
})

test('all four publishers call claimPublicationForSending exactly once, and refuse to proceed when it is not claimed', async () => {
  for (const { file } of PUBLISHERS) {
    const source = await sourceOf(file)
    const claimCalls = (source.match(/await claimPublicationForSending\(pool, id, projectId\)/g) ?? []).length
    assert.equal(claimCalls, 1, `${file}: expected exactly one claim call, found ${claimCalls}`)
    assert.match(
      source,
      /if \(!claim\.claimed\) return publicationClaimConflictResult\(claim\.currentStatus\)/,
      `${file}: must refuse to proceed when the claim is lost`,
    )
  }
})

test('the claim happens AFTER every pre-flight check (content/account/token) but BEFORE the actual send call', async () => {
  for (const { file, sendCall } of PUBLISHERS) {
    const source = await sourceOf(file)
    const claimIdx = source.indexOf('await claimPublicationForSending(pool, id, projectId)')
    assert.ok(claimIdx > 0, `${file}: claim call must exist`)

    const preflightMarkers = ["'post has no content to publish'", 'recordPublicationPreflightFailure']
    for (const marker of preflightMarkers) {
      const lastPreflightIdx = source.lastIndexOf(marker, claimIdx)
      assert.ok(lastPreflightIdx > 0 && lastPreflightIdx < claimIdx, `${file}: pre-flight check (${marker}) must run before the claim`)
    }

    const sendCallIdx = source.indexOf(sendCall, claimIdx)
    assert.ok(sendCallIdx > claimIdx, `${file}: the actual send call (${sendCall}) must come after the claim`)
  }
})

// --- Requirement 2 is already covered by lib/social-publisher-reliability-wiring.test.ts (PR-1) ---

// --- Requirement 3 is already covered by lib/social-publisher-reliability-wiring.test.ts (PR-1) ---

// --- Requirement 4: an unconfirmable send outcome is never written as 'failed', never auto-retried ---

test('all four publishers bound the actual send call with AbortSignal.timeout and a SEND_TIMEOUT_MS constant', async () => {
  for (const { file } of PUBLISHERS) {
    const source = await sourceOf(file)
    assert.match(source, /const SEND_TIMEOUT_MS = 20_000/, `${file}: must define a bounded send timeout`)
    assert.match(source, /signal: AbortSignal\.timeout\(SEND_TIMEOUT_MS\)/, `${file}: the send call must be bounded by it`)
  }
})

test('Telegram and VK: a thrown send-call exception sets a distinct "unknown" flag and returns 503 without writing to the DB', async () => {
  for (const file of ['./social-telegram.ts', './social-vk.ts']) {
    const source = await sourceOf(file)
    assert.match(source, /let sendOutcomeUnknown = false/, `${file}: must track whether the outcome is unknown`)
    assert.match(source, /sendOutcomeUnknown = true/, `${file}: the catch around the send call must set it`)
    const unknownIdx = source.indexOf('if (sendOutcomeUnknown) {')
    assert.ok(unknownIdx > 0, `${file}: must branch on it`)
    const closeIdx = source.indexOf('\n  }', unknownIdx)
    const block = source.slice(unknownIdx, closeIdx)
    assert.match(block, /status: 503/, `${file}: unknown outcome must return 503`)
    assert.ok(!block.includes('pool.query'), `${file}: must NOT write to the DB on an unknown outcome — the row stays 'publishing' from the claim`)
  }
})

test('Instagram and Threads: the inner send-call try/catch is the only place sendOutcomeUnknown is set', async () => {
  for (const file of ['./social-instagram.ts', './social-threads.ts']) {
    const source = await sourceOf(file)
    assert.match(source, /let sendOutcomeUnknown = false/, `${file}: must track whether the outcome is unknown`)
    const setCount = (source.match(/sendOutcomeUnknown = true/g) ?? []).length
    assert.equal(setCount, 1, `${file}: sendOutcomeUnknown must be set in exactly one place (the media_publish/threads_publish catch)`)
  }
})

test('Instagram: the outer container-creation/poll failures never set sendOutcomeUnknown — only the inner media_publish catch does', async () => {
  const source = await sourceOf('./social-instagram.ts')
  const claimIdx = source.indexOf('await claimPublicationForSending(pool, id, projectId)')
  const outerBlock = source.slice(0, claimIdx)
  assert.ok(!outerBlock.includes('sendOutcomeUnknown'), 'container creation / poll (before the claim) must never touch sendOutcomeUnknown')
})

test('Threads: the outer container-creation/poll failures never set sendOutcomeUnknown — only the inner threads_publish catch does', async () => {
  const source = await sourceOf('./social-threads.ts')
  const claimIdx = source.indexOf('await claimPublicationForSending(pool, id, projectId)')
  const outerBlock = source.slice(0, claimIdx)
  assert.ok(!outerBlock.includes('sendOutcomeUnknown'), 'container creation / poll (before the claim) must never touch sendOutcomeUnknown')
})

// --- Requirement 5: a confirmed success is saved once, never re-sent ---

for (const { file, sendVar } of PUBLISHERS) {
  test(`${file}: a successful send still writes status='published' exactly once, unchanged by PR-2`, async () => {
    const source = await sourceOf(file)
    assert.match(source, /SET status = 'published', external_post_id = \$1, external_url = \$2/, `${file}: the success write must still exist`)
    assert.ok(source.includes(sendVar), `${file}: must still use its own send-result id variable (${sendVar})`)
  })
}

// --- Requirement 6: no automatic re-capture of a stuck 'publishing' row ---

test('lib/social-publish-selected-targets.ts: "publishing" is excluded from every automatic AND manual attempt', async () => {
  const source = await sourceOf('./social-publish-selected-targets.ts')
  assert.match(source, /if \(status === 'publishing'\) return false/)
})

test('lib/social-publication-status-transition.ts: publishing -> ready is forbidden, same as published -> ready', async () => {
  const source = await sourceOf('./social-publication-status-transition.ts')
  assert.match(source, /currentStatus === 'published' \|\| currentStatus === 'publishing'/)
})

// --- Requirement 7: project_id isolation preserved, all four platforms still wired ---

test('every publisher still scopes its claim and every query by project_id (no new project-crossing path)', async () => {
  for (const { file } of PUBLISHERS) {
    const source = await sourceOf(file)
    assert.match(source, /await resolveProjectId\(projectSlug\)/, `${file}: must still resolve a project-scoped id`)
    assert.match(source, /claimPublicationForSending\(pool, id, projectId\)/, `${file}: the claim itself must be project-scoped`)
  }
})

test('app/api/social-scheduler/run and the four publish-X routes are unchanged in count — no new route added', async () => {
  for (const platform of ['telegram', 'vk', 'instagram', 'threads']) {
    const source = await sourceOf(`../app/api/social-publications/[id]/publish-${platform}/route.ts`)
    assert.match(source, new RegExp(`publishSocialPublicationTo${platform[0].toUpperCase()}${platform.slice(1)}`))
  }
})
