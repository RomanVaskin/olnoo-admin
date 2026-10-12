import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Static regression guard on source text — components/app-shell.tsx is a React client component
// using Next.js navigation hooks, which this project's plain `node --test` runner has no DOM/React
// harness to execute (this repo's test convention only covers lib/*.ts pure logic; see the other
// *-wiring.test.ts files for the same reasoning applied to files that use `@/`-aliased imports).
//
// Root cause this guards against regressing: social-posts/social-accounts/ads (the only screens
// that create or publish data under "the current project") used to silently fall back to a project
// slug remembered in localStorage from a PREVIOUS, unrelated browsing session whenever the URL had
// no explicit ?project=. That is exactly how a new Instagram account, or a new post, ended up
// attached to the wrong client's project with no visible action by the admin — confirmed as the
// cause of a production Instagram account and its publications being recorded under project
// "domtrack" while the admin believed they were working on OLNOO's own project. Removed entirely
// (components/app-shell.tsx): these screens now render nothing until a real, explicit ?project= is
// present in the URL (from a bookmark/link or from clicking ProjectSelector) — never guessed.

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(file, import.meta.url), 'utf8')
}

test('app-shell: no localStorage-based fallback can silently choose which project a write-capable screen operates under', async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  assert.ok(
    !/localStorage\.(get|set)Item/.test(source),
    'app-shell.tsx must not read or write any remembered project slug via localStorage (mentioning ' +
      'it in a comment, e.g. explaining why it was removed, is fine) — the project a social-' +
      'accounts/social-posts/ads screen operates under must come only from the current URL or an ' +
      'explicit ProjectSelector click',
  )
})

test('app-shell: social-posts, social-accounts and ads only render once a real project slug is in the URL, with no fallback path', async () => {
  const source = await sourceOf('../components/app-shell.tsx')
  for (const screen of ['social-posts', 'social-accounts', 'ads']) {
    const regex = new RegExp(`active === '${screen}' && project !== 'all'`)
    assert.match(source, regex, `${screen} must stay gated on an explicit, non-'all' project`)
  }
  // `project` itself must be derived directly from the URL's own ?project= param, not from any
  // effect that could overwrite it with a remembered value before these screens render.
  const rawProjectIdx = source.indexOf("searchParams.get('project')")
  assert.ok(rawProjectIdx > 0, 'project must be read directly from the URL search params')
})
