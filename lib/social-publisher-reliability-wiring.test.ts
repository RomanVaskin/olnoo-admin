import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text — lib/social-telegram.ts, lib/social-vk.ts,
// lib/social-instagram.ts, lib/social-threads.ts, lib/social-publish-selected.ts,
// lib/social-scheduler.ts, lib/social-publications.ts, and app/api/social-publications/[id]/route.ts
// all import `@/lib/...`, which this repo's plain `node --test` runner cannot resolve without a
// module-alias loader (see lib/crm-observer.ts's own "No `@/` imports so it runs under `node
// --test`" comment for the same reasoning the other way round); components/sections/
// social-publications.tsx is a React client component for the same reason `*-wiring.test.ts` files
// elsewhere in this repo use a source-text guard instead of importing and rendering it. The actual
// logic each of these wires in is covered by its own direct unit/DB-integration test:
// lib/social-publish-selected-targets.test.ts, lib/social-instagram-publish-outcome.test.ts,
// lib/social-publication-status-transition.test.ts, lib/social-scheduler-lock.test.ts,
// lib/social-publication-preflight-failure.test.ts.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

// --- Requirement 1: scheduler never automatically retries a 'failed' publication ---

test('lib/social-publish-selected.ts: publishSelectedChannels accepts retryFailed and filters targets through shouldAttemptPublicationTarget', async () => {
  const source = await sourceOf('./social-publish-selected.ts')
  assert.match(source, /import \{ shouldAttemptPublicationTarget \} from '@\/lib\/social-publish-selected-targets'/)
  assert.match(source, /options: \{ retryFailed\?: boolean \} = \{\}/)
  assert.match(source, /const retryFailed = options\.retryFailed \?\? true/)
  assert.match(source, /shouldAttemptPublicationTarget\(p\.status, retryFailed\)/)
})

test('lib/social-scheduler.ts: calls publishSelectedChannels with retryFailed: false', async () => {
  const source = await sourceOf('./social-scheduler.ts')
  assert.match(source, /publishSelectedChannels\(pool, post\.id, post\.slug, \{ retryFailed: false \}\)/)
})

test('app/api/social-publications/publish-selected/route.ts: the manual bulk-publish route does NOT pass retryFailed: false (keeps the default, which retries failed channels)', async () => {
  const source = await sourceOf('../app/api/social-publications/publish-selected/route.ts')
  assert.match(source, /publishSelectedChannels\(pool, postId, project\)/, 'manual retry must keep retrying failed channels by default')
  assert.ok(!source.includes('retryFailed'), 'the manual route must not override retryFailed at all')
})

// --- Requirement 2: pre-API-call errors are persisted as 'failed' on each of the 4 publishers ---

test('lib/social-telegram.ts, lib/social-vk.ts, lib/social-instagram.ts, lib/social-threads.ts: all import and call recordPublicationPreflightFailure', async () => {
  for (const file of ['./social-telegram.ts', './social-vk.ts', './social-instagram.ts', './social-threads.ts']) {
    const source = await sourceOf(file)
    assert.match(
      source,
      /import \{ recordPublicationPreflightFailure \} from '@\/lib\/social-publication-preflight-failure'/,
      `${file}: must import recordPublicationPreflightFailure`,
    )
    const callCount = (source.match(/await recordPublicationPreflightFailure\(/g) ?? []).length
    assert.ok(callCount >= 4, `${file}: expected recordPublicationPreflightFailure to be called at multiple pre-flight branches, found ${callCount}`)
  }
})

test('lib/social-telegram.ts: "no content" and "no account" pre-flight branches persist before returning', async () => {
  const source = await sourceOf('./social-telegram.ts')
  const noContentIdx = source.indexOf("'post has no content to publish'")
  assert.ok(noContentIdx > 0)
  assert.match(source.slice(noContentIdx, noContentIdx + 200), /await recordPublicationPreflightFailure\(pool, id, projectId, error\)/)

  const noTokenIdx = source.indexOf('TELEGRAM_BOT_TOKEN is not configured')
  assert.ok(noTokenIdx > 0)
  assert.match(source.slice(noTokenIdx, noTokenIdx + 200), /await recordPublicationPreflightFailure\(pool, id, projectId, error\)/)
})

test('lib/social-vk.ts: token-decrypt and no-group-id pre-flight branches persist before returning', async () => {
  const source = await sourceOf('./social-vk.ts')
  const decryptIdx = source.indexOf('Could not decrypt the stored VK token')
  assert.ok(decryptIdx > 0)
  assert.match(source.slice(decryptIdx, decryptIdx + 200), /await recordPublicationPreflightFailure\(pool, id, projectId, error\)/)

  const groupIdx = source.indexOf('the VK account has no resolved group id')
  assert.ok(groupIdx > 0)
  assert.match(source.slice(groupIdx, groupIdx + 200), /await recordPublicationPreflightFailure\(pool, id, projectId, error\)/)
})

test('lib/social-instagram.ts and lib/social-threads.ts: the project-ownership gate (before the publication row is even fetched) also persists', async () => {
  for (const file of ['./social-instagram.ts', './social-threads.ts']) {
    const source = await sourceOf(file)
    const gateIdx = source.indexOf('if (!projectGate.ok)')
    assert.ok(gateIdx > 0, `${file}: projectGate check must exist`)
    const block = source.slice(gateIdx, gateIdx + 200)
    assert.match(block, /await recordPublicationPreflightFailure\(pool, id, projectId, projectGate\.error\)/)
  }
})

// --- Requirement 3: Instagram treats a successful media_publish as published regardless of permalink ---

test('lib/social-instagram.ts: uses resolveInstagramPublishOutcome instead of the old igError||!mediaId||!permalink check', async () => {
  const source = await sourceOf('./social-instagram.ts')
  assert.match(source, /import \{ resolveInstagramPublishOutcome \} from '@\/lib\/social-instagram-publish-outcome'/)
  // PR-2 added a 4th argument (sendOutcomeUnknown) — see lib/social-publisher-reliability-pr2-wiring.test.ts.
  assert.match(source, /const outcome = resolveInstagramPublishOutcome\(mediaId, permalink, igError, sendOutcomeUnknown\)/)
  assert.ok(!source.includes('igError || !mediaId || !permalink'), 'the old all-or-nothing condition must be gone')
})

test('lib/social-instagram.ts: the permalink fetch no longer sets igError on failure (best-effort only, same as Threads)', async () => {
  const source = await sourceOf('./social-instagram.ts')
  const permaIdx = source.indexOf("fields: 'permalink'")
  assert.ok(permaIdx > 0)
  const block = source.slice(permaIdx, permaIdx + 400)
  assert.match(block, /if \(permaRes\.ok && !permaData\?\.error\) \{\s*\n\s*permalink = /, 'permalink lookup must only set `permalink` on success, never igError on failure')
  assert.ok(!block.includes('igError = (permaData'), 'a failed permalink lookup must not set igError')
})

// --- Requirement 4: published -> ready is blocked in both the API and the UI ---

test('lib/social-publications.ts: updateSocialPublication refuses published -> ready via isForbiddenPublicationStatusTransition', async () => {
  const source = await sourceOf('./social-publications.ts')
  assert.match(source, /import \{ isForbiddenPublicationStatusTransition \} from '@\/lib\/social-publication-status-transition'/)
  assert.match(source, /isForbiddenPublicationStatusTransition\(currentStatus, input\.status\)/)
})

test('components/sections/social-publications.tsx: the "Back to ready" button is gone, and save({ status: \'ready\' }) is never called', async () => {
  const source = await sourceOf('../components/sections/social-publications.tsx')
  assert.ok(!source.includes('backToReady'), 'the dead i18n key must not be referenced')
  assert.ok(!/save\(\{\s*status:\s*'ready'\s*\}\)/.test(source), 'nothing in the Publications UI may set a publication back to "ready"')
})

test('i18n: backToReady key removed from both locales (dead after the button was removed)', async () => {
  for (const file of ['../lib/i18n/messages/en.ts', '../lib/i18n/messages/ru.ts']) {
    const source = await sourceOf(file)
    assert.ok(!source.includes('backToReady'), `${file}: backToReady must be removed`)
  }
})

// --- Requirement 5: the scheduler's advisory lock goes through withSchedulerLock ---

test('lib/social-scheduler.ts: no longer calls pool.query for the advisory lock directly — uses withSchedulerLock', async () => {
  const source = await sourceOf('./social-scheduler.ts')
  assert.match(source, /import \{ withSchedulerLock \} from '@\/lib\/social-scheduler-lock'/)
  assert.match(source, /await withSchedulerLock\(pool, async \(\) => \{/)
  assert.ok(!source.includes('pg_try_advisory_lock'), 'the raw lock SQL must live only in lib/social-scheduler-lock.ts now')
  assert.ok(!source.includes('pg_advisory_unlock'), 'the raw unlock SQL must live only in lib/social-scheduler-lock.ts now')
})
