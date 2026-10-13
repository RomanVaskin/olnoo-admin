import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text for the PR #57 review follow-up fixing two confirmed
// risks — same reasoning as lib/social-publisher-reliability-pr2-wiring.test.ts (the files
// involved all import `@/lib/...`, unresolvable by this repo's plain `node --test` runner). The
// decision logic is covered by direct pure tests: lib/social-publication-status-transition.test.ts.
//
// Risk 1 — "pending" (still in-flight) duplication via plain PATCH: a publication's status could
// be PATCHed from 'publishing' to 'failed' (or anything else) at ANY time, including while the
// claimed attempt was still genuinely running. That re-opened the row to claimPublicationForSending's
// `WHERE status NOT IN ('publishing', 'published')`, letting a second, fully independent claim
// succeed and call the platform's send API a second time — a real duplicate post — while the
// first attempt was still in flight. Fixed by making 'publishing' fully immutable through this
// generic status PATCH, in every direction, not just the previously-blocked `-> ready`.
//
// Risk 2 — a response-body read failure after a successful (2xx) HTTP status was treated the same
// as a confirmed platform rejection. `res.json().catch(() => null)` swallows a body-stream error
// (the connection drops mid-stream, after headers/status arrived) exactly the same way it swallows
// a JSON-syntax error — both land on `data = null`, and the existing `!res.ok || !data?.ok`-style
// check then reads as "rejected" even though a 2xx status means the platform very likely accepted
// (and in Telegram/VK/Instagram/Threads' case, actually SENT) the content. Writing `'failed'` for
// that let a next retry call the platform's send API again for something that may have already
// gone out — a real duplicate post. Fixed in all four publishers: a 2xx response whose body fails
// to read now sets `sendOutcomeUnknown` (the same flag PR-2 already used for a send call that
// threw outright) instead of writing 'failed'.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

const PUBLISHERS = ['./social-telegram.ts', './social-vk.ts', './social-instagram.ts', './social-threads.ts'] as const

// --- Risk 1 ---

test('lib/social-publication-status-transition.ts: "publishing" is forbidden as a FROM status for every nextStatus, not just -> ready', async () => {
  const source = await sourceOf('./social-publication-status-transition.ts')
  const fnIdx = source.indexOf('export function isForbiddenPublicationStatusTransition')
  assert.ok(fnIdx > 0)
  const body = source.slice(fnIdx)
  assert.match(body, /if \(currentStatus === 'publishing'\) return true/, 'must unconditionally forbid any transition out of publishing')
})

test("lib/social-publications.ts: the PATCH error message for a 'publishing' row no longer suggests PATCHing it to failed/published", async () => {
  const source = await sourceOf('./social-publications.ts')
  assert.ok(
    !source.includes('check the platform directly, then set it to "failed" or "published" instead'),
    'the old message offering a PATCH-based recovery path for a stuck "publishing" row must be gone — that path is exactly what risk 1 closed',
  )
  assert.match(source, /cannot have its status changed through this endpoint/, 'must explain the publishing row is immutable through this endpoint')
})

test('components/sections/social-publications.tsx: still shows no status-changing control at all for a "publishing" row (unaffected by this fix, confirmed unchanged)', async () => {
  const source = await sourceOf('../components/sections/social-publications.tsx')
  assert.match(source, /publication\.status === 'publishing' \? \(/, 'the "Publishing…" label branch must still be the only thing rendered for a publishing row')
})

// --- Risk 2 ---

test('all four publishers: the send call no longer uses res.json().catch(() => null) — it separately reads the body and tracks whether that read itself failed', async () => {
  for (const file of PUBLISHERS) {
    const source = await sourceOf(file)
    const claimIdx = source.indexOf('await claimPublicationForSending(pool, id, projectId)')
    assert.ok(claimIdx > 0, `${file}: claim call must exist`)
    const sendBlock = source.slice(claimIdx)
    assert.match(sendBlock, /let bodyReadFailed = false/, `${file}: the send block must track a body-read failure distinctly from a definitive rejection`)
  }
})

test('all four publishers: a 2xx response whose body could not be read sets sendOutcomeUnknown, never a confirmed failure', async () => {
  for (const file of PUBLISHERS) {
    const source = await sourceOf(file)
    const idx = source.indexOf('bodyReadFailed) {')
    assert.ok(idx > 0, `${file}: must branch on (ok && bodyReadFailed)`)
    const precedingLine = source.slice(source.lastIndexOf('\n', idx - 20), idx + 20)
    assert.match(precedingLine, /\.ok && bodyReadFailed\) \{/, `${file}: the condition must require the response to actually be ok`)
    const block = source.slice(idx, source.indexOf('\n    }', idx))
    assert.match(block, /sendOutcomeUnknown = true/, `${file}: must mark the outcome unknown, never write 'failed' here`)
    assert.ok(!block.includes('pool.query'), `${file}: must not write to the DB in this branch — the row stays 'publishing'`)
  }
})

test('all four publishers: a non-2xx response is still a confirmed rejection even if its body also cannot be read', async () => {
  for (const file of PUBLISHERS) {
    const source = await sourceOf(file)
    const claimIdx = source.indexOf('await claimPublicationForSending(pool, id, projectId)')
    const sendBlock = source.slice(claimIdx)
    // The confirmed-rejection branch must still be reachable independent of whether the body
    // parsed — i.e. it must check `!res.ok` (or the file's own response variable), not rely on
    // `data` having been successfully parsed.
    assert.match(sendBlock, /!(res|publishRes)\.ok \|\|/, `${file}: the confirmed-rejection branch must still check the response's own ok flag directly`)
  }
})
