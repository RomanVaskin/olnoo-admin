import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text — lib/social-overview.ts imports `@/lib/db` and
// `@/lib/crm`, which this project's plain `node --test` runner cannot resolve directly (same
// pre-existing limitation documented in lib/social-account-ownership-wiring.test.ts and the other
// *-wiring.test.ts files). The pure computation (summarizeAccountStatusCounts) is fully executed
// and covered by lib/social-overview-metrics.test.ts; this guards the two properties that only
// exist once the DB/slug-resolution is wired in.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

test('lib/social-overview.ts: reuses the already fail-closed slug resolution, never reinvents it', async () => {
  const source = await sourceOf('./social-overview.ts')
  assert.match(source, /from '@\/lib\/leads-project-filter'/, 'must import the existing project-filter helpers')
  assert.match(source, /resolveLeadsProjectFilter/)
  assert.match(source, /wantsAllProjects/)
  const noneIdx = source.indexOf("filter.kind === 'none'")
  assert.ok(noneIdx > 0, "must check for the 'none' case (unknown slug)")
  const returnNullIdx = source.indexOf('return null', noneIdx)
  assert.ok(returnNullIdx > noneIdx && returnNullIdx < noneIdx + 50, "an unknown slug must return null, never fall back to 'all'")
})

test('lib/social-overview.ts: publication failures and account connection errors are two separate queries, never summed', async () => {
  const source = await sourceOf('./social-overview.ts')
  const accountsQueryIdx = source.indexOf('FROM social_accounts')
  assert.ok(accountsQueryIdx > 0)
  const accountsQuery = source.slice(accountsQueryIdx - 200, accountsQueryIdx + 150)
  assert.match(accountsQuery, /GROUP BY status/, 'accounts must be grouped by their own status, not pre-summed into one error number')

  const publicationErrorsScopeIdx = source.indexOf('publicationErrorsScope')
  assert.ok(publicationErrorsScopeIdx > 0, 'must build a dedicated scope/query for publication failures')
  const publicationErrorsQueryIdx = source.indexOf("status = 'failed'", publicationErrorsScopeIdx)
  assert.ok(publicationErrorsQueryIdx > publicationErrorsScopeIdx, "must have its own query filtering by status = 'failed'")
  const publicationErrorsQuery = source.slice(publicationErrorsScopeIdx, publicationErrorsQueryIdx)
  assert.match(publicationErrorsQuery, /FROM social_publications/, 'the failed-publication count must query social_publications, not social_accounts')

  // The two must be independent query results composed into separate result fields, never added
  // together into one number anywhere in this file.
  assert.ok(!/accounts\.error\s*\+|publicationErrors\s*\+.*accounts|accounts\.error.*publicationErrors/.test(source))
})

test('lib/social-overview.ts: "scheduled" is a plain, re-derivable SQL condition, not a guessed/invented metric', async () => {
  const source = await sourceOf('./social-overview.ts')
  const scheduledIdx = source.indexOf('FROM social_posts')
  assert.ok(scheduledIdx > 0)
  const scheduledQuery = source.slice(scheduledIdx - 200, scheduledIdx + 150)
  assert.match(scheduledQuery, /status = 'ready'/)
  assert.match(scheduledQuery, /publish_date <> ''/)
})

test('lib/social-overview.ts: no POST/PATCH/DELETE route exists for the overview — read-only', async () => {
  const source = await sourceOf('../app/api/social/overview/route.ts')
  assert.match(source, /export async function GET/)
  assert.ok(!/export async function (POST|PATCH|DELETE|PUT)/.test(source), 'the overview route must only export GET')
})
