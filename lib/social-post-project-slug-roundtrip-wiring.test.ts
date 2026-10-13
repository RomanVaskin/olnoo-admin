import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text — lib/social.ts imports `@/lib/db`/`@/lib/crm`, which
// this repo's plain `node --test` runner cannot resolve without a module-alias loader (see
// lib/crm-observer.ts's own "No `@/` imports so it runs under `node --test`" comment for the same
// reasoning the other way round), so this is a source-text guard rather than a DB-integration
// test exercising createSocialPost/updateSocialPost/getSocialPost directly.
//
// Bug this guards against regressing (reported after PR #54, which added `project_slug`/
// `project_name` to listSocialPosts's rows for the "All projects" view): createSocialPost and
// updateSocialPost returned the bare `rows[0]` from their own `RETURNING *`, which — unlike
// listSocialPosts's joined query — never included `project_slug`. A freshly created or just-edited
// post therefore reached the client with an EMPTY project slug (`fromApiPost`'s `?? ''` fallback in
// social-view.tsx) even though the admin had already picked a real, specific project to create/
// edit it under (in "all" mode, via CreateForm's own required project select). Any further
// per-post action scoped to that project — editing, deleting, "Generate variants", and in
// particular the Instagram image upload (`POST /api/social/upload-instagram-image?project=`) —
// then sent `project=` (empty) and failed with the server's own raw `"a known project is
// required"` error, surfaced verbatim in the UI.
//
// Fix: createSocialPost/updateSocialPost now re-read the row through getSocialPost (extended to
// join `projects`, the same way listSocialPosts already does) instead of returning `rows[0]`
// directly — using the project already resolved/known for that create/update call, no new
// resolution mechanism. social-view.tsx's Instagram upload handler also gained a defensive
// client-side guard (never send `project=`/`all` to the upload endpoint) with a clear, localized
// message, rather than ever surfacing the server's raw error text.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

test('lib/social.ts: getSocialPost joins projects and selects project_slug/project_name, same as listSocialPosts', async () => {
  const source = await sourceOf('./social.ts')
  const idx = source.indexOf('export async function getSocialPost')
  assert.ok(idx > 0, 'getSocialPost must exist')
  const body = source.slice(idx, source.indexOf('\n}', idx))
  assert.match(body, /JOIN projects p ON p\.id = sp\.project_id/, 'getSocialPost must join projects')
  assert.match(body, /p\.slug AS project_slug/, 'getSocialPost must select project_slug')
  assert.match(body, /p\.name AS project_name/, 'getSocialPost must select project_name')
})

test('lib/social.ts: createSocialPost returns the row through getSocialPost, not the bare INSERT ... RETURNING *', async () => {
  const source = await sourceOf('./social.ts')
  const idx = source.indexOf('export async function createSocialPost')
  assert.ok(idx > 0, 'createSocialPost must exist')
  const nextFnIdx = source.indexOf('\nexport async function', idx + 1)
  const body = source.slice(idx, nextFnIdx > 0 ? nextFnIdx : source.length)
  assert.match(
    body,
    /const created = await getSocialPost\(id, projectSlug\)/,
    'createSocialPost must re-read the just-inserted row through getSocialPost so it carries project_slug/project_name',
  )
  assert.match(body, /return \{ row: created \?\? rows\[0\] \}/)
})

test('lib/social.ts: updateSocialPost returns the row through getSocialPost in every branch, not the bare UPDATE ... RETURNING *', async () => {
  const source = await sourceOf('./social.ts')
  const idx = source.indexOf('export async function updateSocialPost')
  assert.ok(idx > 0, 'updateSocialPost must exist')
  const nextFnIdx = source.indexOf('\nexport async function', idx + 1)
  const body = source.slice(idx, nextFnIdx > 0 ? nextFnIdx : source.length)
  // The "no fields changed" short-circuit already read through getSocialPost before this fix.
  assert.match(body, /const existing = await getSocialPost\(id, projectSlug\)/)
  // The channels-changed branch already re-reads for status reconciliation.
  assert.match(body, /const fresh = await getSocialPost\(id, projectSlug\)/)
  // The remaining (no-channels-change) path must also go through getSocialPost now, not `rows[0]`.
  assert.match(
    body,
    /const updated = await getSocialPost\(id, projectSlug\)/,
    'updateSocialPost\'s final return must re-read through getSocialPost so it carries project_slug/project_name',
  )
  assert.match(body, /return \{ row: updated \?\? rows\[0\] \}/)
})

test('social-view.tsx: Instagram image upload refuses to run without a real, specific project, with a clear localized message — never a blank/"all" project reaching the API', async () => {
  const source = await sourceOf('../components/sections/social-view.tsx')
  const idx = source.indexOf('async function handleImageUpload')
  assert.ok(idx > 0, 'handleImageUpload must exist')
  const body = source.slice(idx, source.indexOf('\n  }', idx + 400))
  assert.match(
    body,
    /if \(!project \|\| project === 'all'\) \{\s*\n\s*setUploadImageError\(t\.socialView\.uploadImageProjectRequired\)\s*\n\s*return\s*\n\s*\}/,
    'must bail out before the fetch with a clear, localized message when project is empty or "all"',
  )
})

test('i18n: uploadImageProjectRequired exists in both locales', async () => {
  for (const file of ['../lib/i18n/messages/en.ts', '../lib/i18n/messages/ru.ts']) {
    const source = await sourceOf(file)
    assert.match(source, /uploadImageProjectRequired: '.+'/, `${file}: must define socialView.uploadImageProjectRequired`)
  }
})
